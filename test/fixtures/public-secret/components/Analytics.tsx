"use client";
export function Analytics() {
  const key = process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE;
  const missing = process.env.ANALYTICS_ID;
  return <span data-k={key} data-a={missing} />;
}
