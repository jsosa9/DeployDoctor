import { createClient } from "@supabase/supabase-js";

// Module scope on purpose: this is what turns an unset variable into a build
// failure rather than a runtime error, and it is the shape the missing-env
// scenario's log comes from.
export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

export const analyticsHost = process.env.ANALYTICS_HOST ?? "localhost";
