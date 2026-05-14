const express = require("express");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY,
);

// Secret ini dipakai untuk menandatangani token login sederhana.
// Di Vercel sebaiknya isi AUTH_TOKEN_SECRET agar token production tidak memakai fallback dev.
const AUTH_TOKEN_SECRET =
  process.env.AUTH_TOKEN_SECRET || "dev-secret-change-me";

// Semua rekap operasional dihitung berdasarkan waktu Makassar (WITA / UTC+8).
const APP_TIMEZONE = "Asia/Makassar";
const APP_UTC_OFFSET = "+08:00";

// Menghasilkan tanggal hari ini versi Makassar dalam format YYYY-MM-DD.
function getMakassarDateString(date = new Date()) {
  return date.toLocaleDateString("en-CA", {
    timeZone: APP_TIMEZONE,
  });
}

// Mengubah tanggal lokal Makassar menjadi rentang UTC agar cocok untuk query Supabase created_at.
function getMakassarDayRange(dateString) {
  return {
    start: new Date(
      `${dateString}T00:00:00.000${APP_UTC_OFFSET}`,
    ).toISOString(),
    end: new Date(`${dateString}T23:59:59.999${APP_UTC_OFFSET}`).toISOString(),
  };
}

// Menghasilkan rentang awal-akhir bulan berdasarkan kalender Makassar, bukan UTC.
function getMakassarMonthRange(month, year) {
  const monthNumber = Number(month);
  const yearNumber = Number(year);
  const lastDay = new Date(yearNumber, monthNumber, 0).getDate();

  return {
    start: new Date(
      `${yearNumber}-${String(monthNumber).padStart(2, "0")}-01T00:00:00.000${APP_UTC_OFFSET}`,
    ).toISOString(),
    end: new Date(
      `${yearNumber}-${String(monthNumber).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}T23:59:59.999${APP_UTC_OFFSET}`,
    ).toISOString(),
  };
}

// Mengirim error validasi dengan format yang konsisten untuk frontend.
function sendValidationError(res, message) {
  return res.status(400).json({
    success: false,
    message,
  });
}

// Urutan status kendaraan dibuat ketat agar status tidak bisa lompat atau diisi nilai sembarang.
const VEHICLE_STATUS_FLOW = {
  dalam_antrian: "sedang_dicuci",
  sedang_dicuci: "selesai",
};

// Base64 URL dipakai supaya token aman diletakkan di header Authorization.
function toBase64Url(value) {
  return Buffer.from(value).toString("base64url");
}

// Signature memastikan isi token tidak bisa diubah manual dari browser.
function signTokenPayload(encodedPayload) {
  return crypto
    .createHmac("sha256", AUTH_TOKEN_SECRET)
    .update(encodedPayload)
    .digest("base64url");
}

// Token berlaku sampai akhir hari Makassar agar sesi kasir mengikuti hari operasional.
function createAuthToken(user) {
  const today = getMakassarDateString();
  const { end } = getMakassarDayRange(today);
  const payload = {
    username: user.username,
    role: user.role,
    exp: new Date(end).getTime(),
  };
  const encodedPayload = toBase64Url(JSON.stringify(payload));
  const signature = signTokenPayload(encodedPayload);

  return `${encodedPayload}.${signature}`;
}

// Membaca dan memvalidasi token dari header Authorization.
function readAuthToken(token) {
  if (!token || !token.includes(".")) return null;

  const [encodedPayload, signature] = token.split(".");
  const expectedSignature = signTokenPayload(encodedPayload);
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);

  if (
    signatureBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)
  ) {
    return null;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    );

    if (!payload.username || !payload.role || Date.now() > payload.exp) {
      return null;
    }

    return payload;
  } catch (error) {
    return null;
  }
}

// Middleware ini memastikan endpoint API hanya bisa dipakai setelah login.
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length)
    : "";
  const user = readAuthToken(token);

  if (!user) {
    return res.status(401).json({
      success: false,
      message: "Silakan login ulang",
    });
  }

  req.user = user;
  next();
}

// Middleware ini membatasi endpoint sensitif hanya untuk owner.
function requireOwner(req, res, next) {
  if (req.user?.role !== "owner") {
    return res.status(403).json({
      success: false,
      message: "Akses hanya untuk owner",
    });
  }

  next();
}

// --- AUTHENTICATION ---

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;
  // Catat percobaan login tanpa menampilkan password agar data sensitif tidak masuk log server.
  console.log(`Mencoba Login: ${username}`);

  if (typeof username !== "string" || typeof password !== "string") {
    return sendValidationError(res, "Username dan password wajib diisi");
  }

  const { data, error } = await supabase
    .from("users")
    .select("username, role, password, password_hash")
    .eq("username", username)
    .single();

  if (error) {
    console.error("Supabase Error:", error.message); // Lihat error spesifiknya di terminal
    return res.status(401).json({
      success: false,
      message: "User tidak ditemukan atau password salah",
    });
  }

  // Login baru memakai password_hash. Kolom password lama hanya fallback sementara saat migrasi.
  const passwordValid = data.password_hash
    ? await bcrypt.compare(password, data.password_hash)
    : password === data.password;

  if (!passwordValid) {
    return res.status(401).json({
      success: false,
      message: "User tidak ditemukan atau password salah",
    });
  }

  console.log("Login Berhasil:", data.username);
  res.json({
    success: true,
    token: createAuthToken(data),
    user: { username: data.username, role: data.role },
  });
});

// --- MASTER DATA ---
app.get("/api/employees", requireAuth, async (req, res) => {
  const { data } = await supabase.from("employees").select("*");
  res.json(data);
});

// --- TRANSAKSI & AKTIVITAS CUCI ---
app.post("/api/transactions", requireAuth, async (req, res) => {
  const { vehicle_type, vehicle_brand, employee_id, price } = req.body;

  try {
    // Validasi backend tetap diperlukan walaupun input frontend sudah memakai required.
    const normalizedVehicleType =
      typeof vehicle_type === "string" ? vehicle_type.toLowerCase().trim() : "";
    const normalizedBrand =
      typeof vehicle_brand === "string" ? vehicle_brand.trim() : "";
    const employeeId = Number(employee_id);
    const parsedPrice = Number(price);

    if (!["mobil", "motor"].includes(normalizedVehicleType)) {
      return sendValidationError(res, "Jenis kendaraan harus mobil atau motor");
    }

    if (!normalizedBrand || normalizedBrand.length > 80) {
      return sendValidationError(
        res,
        "Merek kendaraan wajib diisi dan maksimal 80 karakter",
      );
    }

    if (!Number.isInteger(employeeId) || employeeId <= 0) {
      return sendValidationError(res, "Petugas tidak valid");
    }

    if (!Number.isFinite(parsedPrice) || parsedPrice <= 0) {
      return sendValidationError(res, "Harga harus lebih dari 0");
    }

    // Pastikan transaksi hanya memakai petugas yang benar-benar ada di tabel employees.
    const { data: employee, error: employeeError } = await supabase
      .from("employees")
      .select("id")
      .eq("id", employeeId)
      .single();

    if (employeeError || !employee) {
      return sendValidationError(res, "Petugas tidak ditemukan");
    }

    const { data, error } = await supabase
      .from("wash_transactions")
      .insert([
        {
          vehicle_type: normalizedVehicleType,
          vehicle_brand: normalizedBrand,
          status: "dalam_antrian",
          employee_id: employeeId,
          price: parsedPrice,
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
// UPDATE STATUS KENDARAAN
app.patch("/api/transactions/:id/status", requireAuth, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  try {
    // Validasi id dan status sebelum menyentuh database.
    const transactionId = Number(id);
    const nextStatus = typeof status === "string" ? status.trim() : "";

    if (!Number.isInteger(transactionId) || transactionId <= 0) {
      return sendValidationError(res, "ID transaksi tidak valid");
    }

    if (!Object.values(VEHICLE_STATUS_FLOW).includes(nextStatus)) {
      return sendValidationError(res, "Status tujuan tidak valid");
    }

    // Ambil status saat ini agar server bisa memastikan urutannya benar.
    const { data: transaction, error: findError } = await supabase
      .from("wash_transactions")
      .select("id, status")
      .eq("id", transactionId)
      .single();

    if (findError || !transaction) {
      return res.status(404).json({
        success: false,
        message: "Transaksi tidak ditemukan",
      });
    }

    const allowedNextStatus = VEHICLE_STATUS_FLOW[transaction.status];

    if (allowedNextStatus !== nextStatus) {
      return sendValidationError(res, "Perubahan status tidak sesuai urutan");
    }

    const { error } = await supabase
      .from("wash_transactions")
      .update({ status: nextStatus })
      .eq("id", transactionId);

    if (error) {
      console.error("Update Status Error:", error.message);

      return res.status(500).json({
        success: false,
        message: error.message,
      });
    }

    res.json({
      success: true,
      message: "Status berhasil diupdate",
    });
  } catch (e) {
    console.error("Server Error:", e.message);

    res.status(500).json({
      success: false,
      message: "Terjadi kesalahan server",
    });
  }
});
// --- OPERASIONAL HARIAN (OMSET & PENGELUARAN) ---
app.get("/api/daily-summary", requireAuth, requireOwner, async (req, res) => {
  // Ringkasan harian memakai tanggal Makassar agar cocok dengan jam operasional toko.
  const today = getMakassarDateString();
  const { start, end } = getMakassarDayRange(today);
  console.log("today", today, "start", start, "end", end);

  const { data: trxs } = await supabase
    .from("transactions")
    .select("price")
    .gte("created_at", start)
    .lte("created_at", end);

  const omset = trxs?.reduce((acc, curr) => acc + Number(curr.price), 0) || 0;

  const { data: exps } = await supabase
    .from("operating_expenses")
    .select("amount")
    .gte("created_at", start)
    .lte("created_at", end);

  const pengeluaran =
    exps?.reduce((acc, curr) => acc + Number(curr.amount), 0) || 0;

  res.json({ omset, pengeluaran, profit: omset - pengeluaran });
});

app.post("/api/expenses", requireAuth, requireOwner, async (req, res) => {
  const { description, amount } = req.body;

  // Validasi pengeluaran mencegah nominal kosong/aneh masuk ke laporan operasional.
  const normalizedDescription =
    typeof description === "string" ? description.trim() : "";
  const parsedAmount = Number(amount);

  if (!normalizedDescription || normalizedDescription.length > 120) {
    return sendValidationError(
      res,
      "Deskripsi pengeluaran wajib diisi dan maksimal 120 karakter",
    );
  }

  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    return sendValidationError(res, "Nominal pengeluaran harus lebih dari 0");
  }

  const { error } = await supabase
    .from("operating_expenses")
    .insert([{ description: normalizedDescription, amount: parsedAmount }]);

  if (error) {
    console.error("Insert Expense Error:", error.message);
    return res.status(500).json({ success: false, message: error.message });
  }

  res.json({ success: true });
});

app.get("/api/wash-activity", requireAuth, async (req, res) => {
  // Aktivitas cuci hari ini difilter dari jam 00:00 sampai 23:59 versi Makassar.
  const today = getMakassarDateString();
  const { start, end } = getMakassarDayRange(today);
  const { data: logs } = await supabase
    .from("wash_transactions")
    .select("*, employees(name)")
    .gte("created_at", start)
    .lte("created_at", end)
    .order("created_at", { ascending: false });

  const summary = {
    total: logs?.length || 0,
    mobil: logs?.filter((l) => l.vehicle_type === "mobil").length || 0,
    motor: logs?.filter((l) => l.vehicle_type === "motor").length || 0,
  };
  res.json({ logs, summary });
});

// Endpoint Rekap Payroll Khusus Owner
app.get(
  "/api/admin/payroll-recap",
  requireAuth,
  requireOwner,
  async (req, res) => {
    const { month, year } = req.query;

    try {
      // 1. Ambil data semua karyawan
      const { data: employees, error: empError } = await supabase
        .from("employees")
        .select("id, name");

      if (empError) throw empError;

      // 2. Tentukan rentang bulan berdasarkan timezone Makassar agar payroll tidak bergeser tanggal.
      const { start: startDate, end: endDate } = getMakassarMonthRange(
        month,
        year,
      );

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
  },
);

app.get("/api/rekap-harian", requireAuth, async (req, res) => {
  let { date } = req.query;

  // Filter tanggal memakai batas hari Makassar, lalu dikonversi ke UTC untuk Supabase.
  const { start, end } = getMakassarDayRange(date);

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
    // Revenue hanya dikirim ke owner; staf tetap bisa melihat rekap kendaraan tanpa omzet.
    const revenue =
      req.user.role === "owner"
        ? data.reduce((sum, t) => sum + Number(t.price || 0), 0)
        : null;

    const startTime =
      data.length > 0
        ? new Date(data[0].created_at).toLocaleTimeString("id-ID", {
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
            timeZone: "Asia/Makassar",
          })
        : "--:--";
    const lastTime =
      data.length > 0
        ? new Date(data[data.length - 1].created_at).toLocaleTimeString(
            "id-ID",
            {
              hour: "2-digit",
              minute: "2-digit",
              hour12: false,
              timeZone: "Asia/Makassar",
            },
          )
        : "--:--";

    res.json({
      summary: { mobil, motor, revenue, startTime, lastTime },
      transactions: data.map((t) => ({
        id: t.id,
        time: new Date(t.created_at).toLocaleTimeString("id-ID", {
          hour: "2-digit",
          minute: "2-digit",
          timeZone: "Asia/Makassar",
        }),
        vehicle_type: t.vehicle_type,
        vehicle_brand: t.vehicle_brand,
        status: t.status,
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
