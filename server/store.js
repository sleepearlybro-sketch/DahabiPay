import { supabaseAdmin, throwIfError } from './supabase.js';

const db = () => supabaseAdmin();

export async function getSettings() {
  return throwIfError(await db().from('exchange_settings').select('*').eq('id', 1).single(), 'Load exchange settings');
}

export async function createRequest(input) {
  const args = {
    p_reference: input.reference,
    p_quote_jti: input.quoteJti,
    p_customer_auth_id: input.customerAuthId,
    p_full_name: input.fullName,
    p_email: input.email,
    p_whatsapp: input.whatsapp,
    p_moneygo_account: input.moneygoAccount,
    p_send_usdt: input.sendUsdt,
    p_rate: input.rate,
    p_receive_usd: input.receiveUsd,
    p_customer_note: input.note || '',
    p_source_ip: input.ip || null,
    p_user_agent: input.userAgent || null
  };
  const result = await db().rpc('create_exchange_request', args);
  if (!result.error) return result.data;
  if (result.error.code === '23505') {
    const existing = await db().from('exchange_requests').select('*').eq('quote_jti', input.quoteJti).maybeSingle();
    if (!existing.error && existing.data && existing.data.customer_auth_id === input.customerAuthId) return existing.data;
  }
  return throwIfError(result, 'Create exchange request');
}

export async function createCustomerSession({ tokenHash, customerAuthId, email, expiresAt, ip, userAgent }) {
  return throwIfError(await db().from('customer_sessions').insert({
    token_hash: tokenHash,
    customer_auth_id: customerAuthId,
    email,
    expires_at: expiresAt,
    ip,
    user_agent: userAgent
  }).select('token_hash,customer_auth_id,email,expires_at').single(), 'Create customer session');
}

export async function getCustomerSession(tokenHash) {
  const session = throwIfError(await db().from('customer_sessions')
    .select('token_hash,customer_auth_id,email,expires_at').eq('token_hash', tokenHash).maybeSingle(), 'Load customer session');
  if (!session || new Date(session.expires_at).getTime() <= Date.now()) return null;
  return { session, customer: { id: session.customer_auth_id, email: session.email } };
}

export async function deleteCustomerSession(tokenHash) {
  throwIfError(await db().from('customer_sessions').delete().eq('token_hash', tokenHash), 'Delete customer session');
}

export async function pruneCustomerSessions() {
  await db().from('customer_sessions').delete().lte('expires_at', new Date().toISOString());
}

export async function listCustomerRequests(customerAuthId) {
  return throwIfError(await db().from('exchange_requests')
    .select('id,reference,send_usdt,rate,receive_usd,status,created_at,updated_at')
    .eq('customer_auth_id', customerAuthId)
    .order('created_at', { ascending: false }).limit(100), 'Load customer requests');
}

export async function findActiveStaffByEmail(email) {
  const result = await db().from('staff_profiles').select('*').eq('email', email).eq('active', true).maybeSingle();
  return throwIfError(result, 'Find staff account');
}

export async function findActiveStaffByIdentifier(identifier) {
  const field = identifier.includes('@') ? 'email' : 'username';
  return throwIfError(await db().from('staff_profiles').select('*').eq(field, identifier).eq('active', true).maybeSingle(), 'Find staff account');
}

export async function listStaff() {
  return throwIfError(await db().from('staff_profiles').select('user_id,email,username,display_name,role,active,password_enabled,created_at').order('created_at'), 'List staff');
}

export async function createStaffProfile(profile) {
  return throwIfError(await db().from('staff_profiles').insert(profile).select().single(), 'Create staff profile');
}

export async function setStaffCredentials(userId, username) {
  return throwIfError(await db().from('staff_profiles').update({ username, password_enabled: true, updated_at: new Date().toISOString() }).eq('user_id', userId).select().single(), 'Set staff credentials');
}

export async function setStaffActive(userId, active) {
  return throwIfError(await db().from('staff_profiles').update({ active, updated_at: new Date().toISOString() }).eq('user_id', userId).select().single(), 'Update staff account');
}

export async function revokeStaffSessions(userId) {
  throwIfError(await db().from('staff_sessions').delete().eq('staff_user_id', userId), 'Revoke staff sessions');
}

export async function auditStaff(actorId, eventType, targetId) {
  throwIfError(await db().from('request_events').insert({ actor_staff_id: actorId, event_type: eventType, detail: { targetStaffId: targetId } }), 'Audit staff action');
}

export async function createStaffSession({ tokenHash, staffUserId, expiresAt, ip, userAgent }) {
  return throwIfError(await db().from('staff_sessions').insert({
    token_hash: tokenHash,
    staff_user_id: staffUserId,
    expires_at: expiresAt,
    ip,
    user_agent: userAgent
  }).select().single(), 'Create staff session');
}

export async function getStaffSession(tokenHash) {
  const session = throwIfError(await db().from('staff_sessions')
    .select('token_hash,staff_user_id,expires_at').eq('token_hash', tokenHash).maybeSingle(), 'Load staff session');
  if (!session || new Date(session.expires_at).getTime() <= Date.now()) return null;
  const staff = throwIfError(await db().from('staff_profiles').select('*')
    .eq('user_id', session.staff_user_id).eq('active', true).maybeSingle(), 'Load staff profile');
  return staff ? { session, staff } : null;
}

export async function deleteStaffSession(tokenHash) {
  throwIfError(await db().from('staff_sessions').delete().eq('token_hash', tokenHash), 'Delete staff session');
}

export async function pruneStaffSessions() {
  await db().from('staff_sessions').delete().lte('expires_at', new Date().toISOString());
}

export async function dashboard() {
  const statuses = ['verified', 'contacted', 'in_progress', 'completed'];
  const counts = {};
  await Promise.all(statuses.map(async (status) => {
    const result = await db().from('exchange_requests').select('id', { count: 'exact', head: true }).eq('status', status);
    if (result.error) throw new Error(`Dashboard count: ${result.error.message}`);
    counts[status] = result.count || 0;
  }));
  const recent = throwIfError(await db().from('exchange_requests').select('*')
    .order('created_at', { ascending: false }).limit(8), 'Load recent requests');
  return { counts, recent };
}

export async function listRequests({ status, query, from, to, page = 1, limit = 25 }) {
  const offset = (page - 1) * limit;
  let request = db().from('exchange_requests').select('*', { count: 'exact' });
  if (status) request = request.eq('status', status);
  if (from) request = request.gte('created_at', `${from}T00:00:00.000Z`);
  if (to) request = request.lte('created_at', `${to}T23:59:59.999Z`);
  if (query) {
    const safe = query.replace(/[%_,()'"\\]/g, ' ').trim().slice(0, 120);
    request = request.or(`reference.ilike.%${safe}%,full_name.ilike.%${safe}%,email.ilike.%${safe}%,whatsapp.ilike.%${safe}%`);
  }
  const result = await request.order('created_at', { ascending: false }).range(offset, offset + limit - 1);
  const data = throwIfError(result, 'List exchange requests');
  return { requests: data, total: result.count || 0, page, limit };
}

export async function getRequest(id) {
  const request = throwIfError(await db().from('exchange_requests').select('*').eq('id', id).maybeSingle(), 'Load request');
  if (!request) return null;
  const [notesResult, eventsResult] = await Promise.all([
    db().from('request_notes').select('*,staff_profiles(display_name,email)').eq('request_id', id).order('created_at'),
    db().from('request_events').select('*,staff_profiles(display_name,email)').eq('request_id', id).order('created_at')
  ]);
  return {
    request,
    notes: throwIfError(notesResult, 'Load request notes'),
    events: throwIfError(eventsResult, 'Load request events')
  };
}

export async function transitionRequest({ requestId, staffUserId, status, reason }) {
  return throwIfError(await db().rpc('transition_exchange_request', {
    p_request_id: requestId,
    p_staff_user_id: staffUserId,
    p_next_status: status,
    p_reason: reason || null
  }), 'Update request status');
}

export async function addNote({ requestId, staffUserId, body }) {
  return throwIfError(await db().rpc('add_request_note', {
    p_request_id: requestId,
    p_staff_user_id: staffUserId,
    p_body: body
  }), 'Add request note');
}

export async function updateSettings(values, staff) {
  const patch = {
    rate: values.rate,
    min_usdt: values.minUsdt,
    max_usdt: values.maxUsdt,
    accepting_requests: values.acceptingRequests,
    operations_email: values.operationsEmail || null,
    support_email: values.supportEmail,
    support_whatsapp: values.supportWhatsapp,
    whatsapp_template: values.whatsappTemplate,
    updated_by: staff.user_id,
    updated_at: new Date().toISOString()
  };
  const settings = throwIfError(await db().from('exchange_settings').update(patch).eq('id', 1).select().single(), 'Update exchange settings');
  throwIfError(await db().from('request_events').insert({
    actor_staff_id: staff.user_id,
    event_type: 'settings.updated',
    detail: { rate: values.rate, minUsdt: values.minUsdt, maxUsdt: values.maxUsdt, acceptingRequests: values.acceptingRequests }
  }), 'Audit exchange settings');
  return settings;
}

export async function pendingNotifications(limit = 10) {
  return throwIfError(await db().from('notification_outbox').select('*')
    .is('delivered_at', null).lte('next_attempt_at', new Date().toISOString())
    .order('created_at').limit(limit), 'Load notification outbox');
}

export async function markNotificationDelivered(id) {
  throwIfError(await db().from('notification_outbox').update({
    delivered_at: new Date().toISOString(), last_error: null
  }).eq('id', id), 'Complete notification');
}

export async function markNotificationFailed(row, message) {
  const attempts = Number(row.attempts || 0) + 1;
  const minutes = Math.min(60, 2 ** Math.min(attempts, 6));
  throwIfError(await db().from('notification_outbox').update({
    attempts,
    last_error: String(message).slice(0, 1000),
    next_attempt_at: new Date(Date.now() + minutes * 60_000).toISOString()
  }).eq('id', row.id), 'Reschedule notification');
}
