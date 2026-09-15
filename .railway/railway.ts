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
      preDeployCommand: ["npm run seed"],
      drainingSeconds: 60,
    },
    env: {
      DATABASE_URL: preserve(),
      PUBLIC_ORIGIN: preserve(),
      NODE_ENV: preserve(),
      HOST: preserve(),
      COOKIE_SECURE: preserve(),
      DB_POOL_MAX: preserve(),
      DB_SSL: preserve(),
      DB_SSL_REJECT_UNAUTHORIZED: preserve(),
      DB_FILE: preserve(),
      START_IN_MAINTENANCE: preserve(),
      CRYPTO_PROVIDER: preserve(),
      MOBILE_PROVIDER: preserve(),
      RATES_REFRESH_SEC: preserve(),
      RATES_MAX_STALE_SEC: preserve(),
      ADMIN_LOGIN: preserve(),
      ADMIN_EMAIL: preserve(),
      ADMIN_PASSWORD: preserve(),
      CRON_SECRET: preserve(),
    },
    volumeMounts: { "/data": data },
  });
  return project("jubilant-forgiveness", {
    resources: [data, dahabi_pay],
  });
});
