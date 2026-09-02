export const ADMIN_EMAILS = ["in.with.imran@gmail.com"];

export const ADMIN_NAME = "Tabib Imran";

export function isAdminEmail(email) {
  return !!email && ADMIN_EMAILS.includes(email);
}
