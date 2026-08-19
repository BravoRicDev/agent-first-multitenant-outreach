export function normalize(phone) {
  if (!phone || typeof phone !== 'string') return null;
  let cleaned = phone.replace(/[^\d+]/g, '');

  if (cleaned.startsWith('00')) cleaned = '+' + cleaned.slice(2);

  if (cleaned.startsWith('+')) {
    const digits = cleaned.replace(/\D/g, '');
    if (digits.length < 6 || digits.length > 15) return null;
    return '+' + digits;
  }

  const digits = cleaned.replace(/\D/g, '');
  if (digits.length < 6 || digits.length > 15) return null;
  if (digits.startsWith('39') && digits.length > 11) return '+' + digits;
  return '+39' + digits;
}
