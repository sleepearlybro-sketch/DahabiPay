const email = document.querySelector('#contactEmail');
const emailAction = document.querySelector('#emailAction');
const whatsapp = document.querySelector('#contactWhatsapp');
const whatsappAction = document.querySelector('#whatsappAction');
const whatsappUnavailable = document.querySelector('#whatsappUnavailable');
const whatsappDescription = document.querySelector('#whatsappDescription');

try {
  const response = await fetch('/api/public/contact');
  if (!response.ok) throw new Error('Contact details are unavailable');
  const contact = await response.json();
  if (contact.email) {
    email.textContent = contact.email;
    email.href = `mailto:${contact.email}`;
    emailAction.href = `mailto:${contact.email}?subject=${encodeURIComponent('Dahabi Pay support')}`;
  }
  if (contact.whatsapp && /^\+[1-9]\d{7,14}$/.test(contact.whatsapp)) {
    whatsapp.textContent = contact.whatsapp;
    whatsappDescription.textContent = 'Send us a message about your exchange request.';
    whatsappAction.href = `https://wa.me/${contact.whatsapp.slice(1)}?text=${encodeURIComponent('Hello Dahabi Pay, I have a question about an exchange request.')}`;
    whatsapp.classList.remove('hidden');
    whatsappAction.classList.remove('hidden');
    whatsappUnavailable.classList.add('hidden');
  }
} catch {
  whatsappDescription.textContent = 'After you submit a request, our team will contact you on WhatsApp to arrange the next steps.';
}
