export const DISPOSABLE_EMAIL_DOMAINS = new Set([
  "10minutemail.com", "10minutemail.net", "20minutemail.com",
  "guerrillamail.com", "guerrillamail.net", "guerrillamail.org", "guerrillamail.biz",
  "guerrillamail.de", "guerrillamail.info", "guerrillamailblock.com", "sharklasers.com",
  "grr.la", "pokemail.net", "spam4.me",
  "mailinator.com", "mailinator.net", "mailinator.org",
  "mailnesia.com", "mailcatch.com", "mailnull.com", "jetable.org",
  "tempmail.com", "temp-mail.org", "temp-mail.io", "tempmailo.com", "tempinbox.com",
  "throwawaymail.com", "throwam.com",
  "yopmail.com", "yopmail.net", "yopmail.fr",
  "trashmail.com", "trashmail.me", "trashmail.net", "trash-mail.com",
  "wegwerfmail.de", "wegwerfmail.net", "wegwerfmail.org",
  "getnada.com", "getairmail.com", "fakeinbox.com", "fakemailgenerator.com",
  "dispostable.com", "maildrop.cc", "mintemail.com", "mohmal.com", "moakt.com",
  "emailondeck.com", "discard.email", "discardmail.com",
  "1secmail.com", "1secmail.net", "1secmail.org",
  "crazymailing.com", "harakirimail.com", "spamgourmet.com", "incognitomail.com",
  "anonbox.net", "luxusmail.org", "mailforspam.com", "mytrashmail.com",
  "burnermail.io", "mytemp.email", "inboxkitten.com", "nada.email"
]);

export function isDisposableEmail(email) {
  const domain = typeof email === "string" ? email.split("@")[1] : "";
  if (!domain) return false;
  const normalized = domain.toLowerCase().trim();
  if (DISPOSABLE_EMAIL_DOMAINS.has(normalized)) return true;
  for (const blocked of DISPOSABLE_EMAIL_DOMAINS) {
    if (normalized.endsWith(`.${blocked}`)) return true;
  }
  return false;
}
