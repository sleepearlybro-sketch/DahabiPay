import { createClient } from '@supabase/supabase-js';
import { config } from './config.js';

let authClient;
let adminClient;
const options = { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } };

export function supabaseAuth() {
  if (!authClient) {
    if (!config.supabase.url || !config.supabase.publishableKey) throw new Error('Supabase Auth is not configured');
    authClient = createClient(config.supabase.url, config.supabase.publishableKey, options);
  }
  return authClient;
}

export function supabaseAdmin() {
  if (!adminClient) {
    if (!config.supabase.url || !config.supabase.secretKey) throw new Error('Supabase server access is not configured');
    adminClient = createClient(config.supabase.url, config.supabase.secretKey, options);
  }
  return adminClient;
}

export function throwIfError(result, context) {
  if (result.error) {
    const error = new Error(`${context}: ${result.error.message}`);
    error.cause = result.error;
    throw error;
  }
  return result.data;
}
