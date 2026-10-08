import { supabase } from "../../lib/supabase";

export default async function DashboardPage() {
  const { data } = await supabase.from("projects").select("name");

  return (
    <main>
      <h1>{process.env.NEXT_PUBLIC_SITE_NAME}</h1>
      <ul>
        {data?.map((row: { name: string }) => <li key={row.name}>{row.name}</li>)}
      </ul>
    </main>
  );
}
