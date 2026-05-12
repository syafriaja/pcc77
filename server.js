const express = require("express");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY,
);

// --- AUTHENTICATION ---

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;
  console.log(`Mencoba Login: ${username} | ${password}`); // Log input

  const { data, error } = await supabase
    .from("users")
    .select("*")
    .eq("username", username)
    .eq("password", password)
    .single();

  if (error) {
    console.error("Supabase Error:", error.message); // Lihat error spesifiknya di terminal
    return res.status(401).json({
      success: false,
      message: "User tidak ditemukan atau password salah",
    });
  }

  console.log("Login Berhasil:", data.username);
  res.json({
    success: true,
    user: { username: data.username, role: data.role },
  });
});

// --- MASTER DATA ---
app.get("/api/employees", async (req, res) => {
  const { data } = await supabase.from("employees").select("*");
  res.json(data);
});

// --- TRANSAKSI & AKTIVITAS CUCI ---
app.post("/api/transactions", async (req, res) => {
  const { vehicle_type, employee_id, price } = req.body;

  try {
    const { data, error } = await supabase
      .from("wash_transactions")
      .insert([
        {
          vehicle_type: vehicle_type.toLowerCase(), // Pastikan huruf kecil
          employee_id: parseInt(employee_id),
          price: parseFloat(price),
        },
      ])
      .select();

    if (error) {
      console.error("Supabase Insert Error:", error.message);
      return res.status(500).json({ success: false, message: error.message });
    }

    res.json({ success: true, data });
  } catch (e) {
    console.error("Server Error:", e.message);
    res
      .status(500)
      .json({ success: false, message: "Terjadi kesalahan pada server" });
  }
});
// --- OPERASIONAL HARIAN (OMSET & PENGELUARAN) ---
app.get("/api/daily-summary", async (req, res) => {
  const today = new Date().toISOString().split("T")[0];
  const start = `${today}T00:00:00.000Z`;
  const end = `${today}T23:59:59.999Z`;

  // Ambil Omset
  const { data: trxs } = await supabase
    .from("transactions")
    .select("price")
    .gte("created_at", start)
    .lte("created_at", end);
  const omset = trxs?.reduce((acc, curr) => acc + Number(curr.price), 0) || 0;

  // Ambil Pengeluaran
  const { data: exps } = await supabase
    .from("operating_expenses")
    .select("amount")
    .gte("created_at", start)
    .lte("created_at", end);
  const pengeluaran =
    exps?.reduce((acc, curr) => acc + Number(curr.amount), 0) || 0;

  res.json({ omset, pengeluaran, profit: omset - pengeluaran });
});

app.post("/api/expenses", async (req, res) => {
  const { description, amount } = req.body;
  await supabase.from("operating_expenses").insert([{ description, amount }]);
  res.json({ success: true });
});

app.get("/api/wash-activity", async (req, res) => {
  const today = new Date().toISOString().split("T")[0];
  const { data: logs } = await supabase
    .from("wash_transactions")
    .select("*, employees(name)")
    .gte("created_at", `${today}T00:00:00Z`)
    .order("created_at", { ascending: false });

  const summary = {
    total: logs?.length || 0,
    mobil: logs?.filter((l) => l.vehicle_type === "mobil").length || 0,
    motor: logs?.filter((l) => l.vehicle_type === "motor").length || 0,
  };
  res.json({ logs, summary });
});

// Endpoint Rekap Payroll Khusus Owner
app.get("/api/admin/payroll-recap", async (req, res) => {
  const { month, year } = req.query;

  try {
    // 1. Ambil data semua karyawan
    const { data: employees, error: empError } = await supabase
      .from("employees")
      .select("id, name");

    if (empError) throw empError;

    // 2. Tentukan rentang waktu bulan yang dipilih
    const startDate = `${year}-${month.padStart(2, "0")}-01T00:00:00Z`;
    const lastDay = new Date(year, month, 0).getDate();
    const endDate = `${year}-${month.padStart(2, "0")}-${lastDay}T23:59:59Z`;

    // 3. Ambil transaksi cucian pada periode tersebut
    const { data: transactions, error: transError } = await supabase
      .from("wash_transactions")
      .select("vehicle_type, employee_id")
      .gte("created_at", startDate)
      .lte("created_at", endDate);

    if (transError) throw transError;

    // 4. Hitung rekap gaji per karyawan
    const recap = employees.map((emp) => {
      const empTrans = transactions.filter((t) => t.employee_id === emp.id);

      // Hitung jumlah unit (case insensitive)
      const m = empTrans.filter(
        (t) => t.vehicle_type.toLowerCase() === "mobil",
      ).length;
      const t = empTrans.filter(
        (t) => t.vehicle_type.toLowerCase() === "motor",
      ).length;

      const gajiPokok = 1000000;

      // Jalur 1 (S1) = (Mobil - 40) * 27rb + Motor * 10rb
      const s1 = (m - 40) * 27000 + t * 10000;

      // Jalur 2 (S2) = (Mobil - 30) * 27rb + (Motor - 20) * 10rb
      const s2 = (m - 30) * 27000 + (t - 20) * 10000;

      // Ambil bonus terbesar (bisa bernilai minus jika tidak capai target)
      const bonusAkhir = Math.max(s1, s2);
      const finalSalary = gajiPokok + bonusAkhir;

      return {
        id: emp.id,
        name: emp.name,
        m,
        t,
        s1,
        s2,
        bonus_akhir: bonusAkhir,
        final_salary: finalSalary,
      };
    });
    res.json(recap);
  } catch (error) {
    console.error("Payroll Error:", error);
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/rekap-harian", async (req, res) => {
  let { date, role } = req.query;

  // Pastikan filter tanggal tepat (YYYY-MM-DD)
  const start = `${date}T00:00:00Z`;
  const end = `${date}T23:59:59Z`;

  try {
    const { data, error } = await supabase
      .from("wash_transactions")
      .select(
        `
                *,
                employees (name)
            `,
      )
      .gte("created_at", start)
      .lte("created_at", end)
      .order("created_at", { ascending: true });

    if (error) throw error;

    // Hitung Summary
    const mobil = data.filter((t) => t.vehicle_type === "mobil").length;
    const motor = data.filter((t) => t.vehicle_type === "motor").length;
    const revenue = data.reduce((sum, t) => sum + Number(t.price || 0), 0);

    const startTime =
      data.length > 0
        ? new Date(data[0].created_at).toLocaleTimeString("id-ID", {
            hour: "2-digit",
            minute: "2-digit",
          })
        : "--:--";
    const lastTime =
      data.length > 0
        ? new Date(data[data.length - 1].created_at).toLocaleTimeString(
            "id-ID",
            { hour: "2-digit", minute: "2-digit" },
          )
        : "--:--";

    res.json({
      summary: { mobil, motor, revenue, startTime, lastTime },
      transactions: data.map((t) => ({
        time: new Date(t.created_at).toLocaleTimeString("id-ID", {
          hour: "2-digit",
          minute: "2-digit",
        }),
        vehicle_type: t.vehicle_type,
        employee_name: t.employees?.name || "N/A",
        price: t.price,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.use((req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

module.exports = app;
//app.get("*", (req, res) => {
//res.sendFile(path.join(__dirname, "public", "index.html"));
//});

//for render
//const PORT = process.env.PORT || 3000;
//app.listen(PORT, () => console.log(`ShinePos running on port ${PORT}`));
