import { defineRailway, preserve, project, service, volume } from "railway/iac";

// Last resort for a per-service CaC repo. Prefer one .railway file for the
// project and drop this if you later combine services into that file.
export const partial = "dahabi-pay";

export default defineRailway(() => {
  const data = volume("dahabi-pay-volume", { region: "sfo", sizeMB: 500 });
  const dahabi_pay = service("dahabi-pay", {
    deploy: {
      healthcheckPath: "/api/health",
      healthcheckTimeout: 180,
      drainingSeconds: 60,
    },
    env: {
      PUBLIC_ORIGIN: preserve(),
      NODE_ENV: preserve(),
      HOST: preserve(),
      COOKIE_SECURE: preserve(),
      SUPABASE_URL: preserve(),
      SUPABASE_PUBLISHABLE_KEY: preserve(),
      SUPABASE_SECRET_KEY: preserve(),
      QUOTE_SIGNING_SECRET: preserve(),
      QUOTE_TTL_MINUTES: preserve(),
      STAFF_SESSION_HOURS: preserve(),
      SMTP_HOST: preserve(),
      SMTP_PORT: preserve(),
      SMTP_SECURE: preserve(),
      SMTP_USER: preserve(),
      SMTP_PASS: preserve(),
      MAIL_FROM: preserve(),
    },
    volumeMounts: { "/data": data },
  });
  return project("jubilant-forgiveness", {
    resources: [data, dahabi_pay],
  });
});
