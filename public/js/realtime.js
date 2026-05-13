const supabaseUrl = "https://npxkgrsolcnqlzosnhqi.supabase.co";
const supabaseKey = "sb_publishable_ojhDv18j5aXPKOQr-xXtDg_4Ow0IjyC";
const supabaseClient = supabase.createClient(supabaseUrl, supabaseKey);

console.log("Realtime connected");
const channel = supabaseClient
  .channel("wash-transactions-realtime")
  .on(
    "postgres_changes",
    {
      event: "*",
      schema: "public",
      table: "wash_transactions",
    },
    (payload) => {
      console.log("Realtime update:", payload);

      // trigger event global
      window.dispatchEvent(new Event("refresh-data"));
    },
  )
  .subscribe((status) => {
    console.log("STATUS", status);
  });
