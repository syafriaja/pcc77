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

// Aturan bawaan ini dipakai saat tabel payroll_settings belum tersedia.
// Owner tetap bisa mengubah nominalnya dari halaman Payroll setelah tabel dibuat.
const DEFAULT_COMPENSATION_SETTINGS = [
  {
    key: "mobil_kecil",
    label: "Mobil kecil",
    vehicle_type: "mobil",
    vehicle_size: "kecil",
    payroll_value: 23000,
    daily_bonus_value: 7000,
  },
  {
    key: "mobil_sedang",
    label: "Mobil sedang",
    vehicle_type: "mobil",
    vehicle_size: "sedang",
    payroll_value: 27000,
    daily_bonus_value: 8000,
  },
  {
    key: "mobil_besar",
    label: "Mobil besar",
    vehicle_type: "mobil",
    vehicle_size: "besar",
    payroll_value: 31000,
    daily_bonus_value: 9000,
  },
  {
    key: "motor_kecil",
    label: "Motor kecil",
    vehicle_type: "motor",
    vehicle_size: "kecil",
    payroll_value: 7000,
    daily_bonus_value: 3000,
  },
  {
    key: "motor_besar",
    label: "Motor besar",
    vehicle_type: "motor",
    vehicle_size: "besar",
    payroll_value: 11000,
    daily_bonus_value: 4000,
  },
];

const DEFAULT_COMPENSATION_MAP = Object.fromEntries(
  DEFAULT_COMPENSATION_SETTINGS.map((setting) => [setting.key, setting]),
);

const TARGET_MAP = {
  mobil: 45,
  motor: 30,
};

function isFullWash(transaction) {
  return (transaction.service_category || "fullwash") === "fullwash";
}

// Kunci seperti "mobil_kecil" dipakai agar aturan upah mudah dicocokkan
// dengan jenis dan ukuran kendaraan.
function getCompensationKey(vehicleType, vehicleSize) {
  const normalizedSize =
    vehicleSize || (vehicleType === "motor" ? "kecil" : "sedang");
  return `${vehicleType}_${normalizedSize}`;
}

function normalizeCompensationSettings(settings = []) {
  return DEFAULT_COMPENSATION_SETTINGS.map((defaultSetting) => {
    const savedSetting = settings.find(
      (setting) => setting.key === defaultSetting.key,
    );

    return {
      ...defaultSetting,
      payroll_value: hasStoredNumber(savedSetting?.payroll_value)
        ? Number(savedSetting.payroll_value)
        : defaultSetting.payroll_value,
      daily_bonus_value: hasStoredNumber(savedSetting?.daily_bonus_value)
        ? Number(savedSetting.daily_bonus_value)
        : defaultSetting.daily_bonus_value,
    };
  });
}

// Mengambil aturan payroll dari Supabase. Kalau gagal, sistem tetap jalan
// memakai nilai bawaan agar transaksi kasir tidak ikut berhenti.
async function getCompensationSettings() {
  const { data, error } = await supabase
    .from("payroll_settings")
    .select(
      "key, label, vehicle_type, vehicle_size, payroll_value, daily_bonus_value",
    );

  if (error) {
    console.warn("Payroll settings fallback:", error.message);
    return DEFAULT_COMPENSATION_SETTINGS;
  }

  return normalizeCompensationSettings(data || []);
}

async function getCompensationMap() {
  const settings = await getCompensationSettings();
  return Object.fromEntries(settings.map((setting) => [setting.key, setting]));
}

// Bonus harian sekarang nominal tetap per jenis/ukuran kendaraan,
// bukan persentase dari harga wash.
function calculateBonus(vehicleType, vehicleSize, serviceCategory, settingsMap) {
  if (serviceCategory !== "fullwash") return 0;
  const setting =
    settingsMap?.[getCompensationKey(vehicleType, vehicleSize)] ||
    DEFAULT_COMPENSATION_MAP[getCompensationKey(vehicleType, vehicleSize)];

  return setting?.daily_bonus_value || 0;
}

function calculatePayrollValue(
  vehicleType,
  vehicleSize,
  serviceCategory,
  settingsMap,
) {
  // Non-target dibayar langsung, jadi tidak boleh masuk payroll.
  if (serviceCategory !== "fullwash") return 0;
  const setting =
    settingsMap?.[getCompensationKey(vehicleType, vehicleSize)] ||
    DEFAULT_COMPENSATION_MAP[getCompensationKey(vehicleType, vehicleSize)];

  return setting?.payroll_value || 0;
}

function getTargetProgress(count, target) {
  if (!target) return 0;
  return Math.min(Math.round((count / target) * 100), 100);
}

function hasStoredNumber(value) {
  return (
    value !== null && value !== undefined && Number.isFinite(Number(value))
  );
}

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
  const {
    vehicle_type,
    vehicle_size,
    service_category,
    vehicle_brand,
    employee_id,
    price,
  } = req.body;

  try {
    // Validasi backend tetap diperlukan walaupun input frontend sudah memakai required.
    const normalizedVehicleType =
      typeof vehicle_type === "string" ? vehicle_type.toLowerCase().trim() : "";
    const normalizedVehicleSize =
      typeof vehicle_size === "string" ? vehicle_size.toLowerCase().trim() : "";
    const normalizedServiceCategory =
      typeof service_category === "string"
        ? service_category.toLowerCase().trim()
        : "fullwash";
    const normalizedBrand =
      typeof vehicle_brand === "string" ? vehicle_brand.trim() : "";
    const employeeId = Number(employee_id);
    const parsedPrice = Number(price);

    // Validasi ini menjaga data yang masuk tetap sesuai pilihan resmi di aplikasi.
    if (!["mobil", "motor"].includes(normalizedVehicleType)) {
      return sendValidationError(res, "Jenis kendaraan harus mobil atau motor");
    }

    if (!["kecil", "sedang", "besar"].includes(normalizedVehicleSize)) {
      return sendValidationError(
        res,
        "Ukuran kendaraan harus kecil, sedang, atau besar",
      );
    }

    if (!["fullwash", "non_target"].includes(normalizedServiceCategory)) {
      return sendValidationError(
        res,
        "Kategori layanan harus fullwash atau non_target",
      );
    }

    if (
      normalizedServiceCategory === "fullwash" &&
      !DEFAULT_COMPENSATION_MAP[
        getCompensationKey(normalizedVehicleType, normalizedVehicleSize)
      ]
    ) {
      return sendValidationError(
        res,
        "Kombinasi kendaraan dan ukuran belum memiliki nilai payroll",
      );
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
      .select("id, name")
      .eq("id", employeeId)
      .single();

    if (employeeError || !employee) {
      return sendValidationError(res, "Petugas tidak ditemukan");
    }

    // Nilai payroll dan bonus disimpan ke transaksi saat dibuat.
    // Dengan begitu, transaksi lama tidak berubah walaupun aturan diedit nanti.
    const compensationMap = await getCompensationMap();
    const bonusAmount = calculateBonus(
      normalizedVehicleType,
      normalizedVehicleSize,
      normalizedServiceCategory,
      compensationMap,
    );
    const payrollValue = calculatePayrollValue(
      normalizedVehicleType,
      normalizedVehicleSize,
      normalizedServiceCategory,
      compensationMap,
    );

    const { data, error } = await supabase
      .from("wash_transactions")
      .insert([
        {
          vehicle_type: normalizedVehicleType,
          vehicle_size: normalizedVehicleSize,
          service_category: normalizedServiceCategory,
          vehicle_brand: normalizedBrand,
          status: "dalam_antrian",
          employee_id: employeeId,
          employee_name: employee.name,
          price: parsedPrice,
          bonus_amount: bonusAmount,
          payroll_value: payrollValue,
          input_by: req.user.role,
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

app.get(
  "/api/admin/payroll-settings",
  requireAuth,
  requireOwner,
  async (req, res) => {
    try {
      const settings = await getCompensationSettings();
      res.json({ success: true, settings });
    } catch (error) {
      console.error("Payroll Settings Error:", error.message);
      res.status(500).json({
        success: false,
        message: "Gagal memuat aturan payroll",
      });
    }
  },
);

// Endpoint ini dipakai owner untuk mengubah aturan upah dari halaman Payroll.
// Perubahan hanya memengaruhi transaksi baru setelah disimpan.
app.put(
  "/api/admin/payroll-settings",
  requireAuth,
  requireOwner,
  async (req, res) => {
    const { settings } = req.body;

    if (!Array.isArray(settings)) {
      return sendValidationError(res, "Format aturan payroll tidak valid");
    }

    const normalizedSettings = normalizeCompensationSettings(settings);

    for (const setting of normalizedSettings) {
      if (
        !Number.isFinite(setting.payroll_value) ||
        setting.payroll_value < 0 ||
        !Number.isFinite(setting.daily_bonus_value) ||
        setting.daily_bonus_value < 0
      ) {
        return sendValidationError(
          res,
          "Nilai payroll dan bonus harian tidak boleh minus",
        );
      }
    }

    const settingsToSave = normalizedSettings.map((setting) => ({
      ...setting,
      updated_at: new Date().toISOString(),
    }));

    const { data, error } = await supabase
      .from("payroll_settings")
      .upsert(settingsToSave, { onConflict: "key" })
      .select(
        "key, label, vehicle_type, vehicle_size, payroll_value, daily_bonus_value",
      );

    if (error) {
      console.error("Update Payroll Settings Error:", error.message);
      return res.status(500).json({
        success: false,
        message: error.message,
      });
    }

    res.json({
      success: true,
      settings: normalizeCompensationSettings(data || normalizedSettings),
    });
  },
);

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
    total: logs?.filter(isFullWash).length || 0,
    mobil:
      logs?.filter((l) => isFullWash(l) && l.vehicle_type === "mobil").length ||
      0,
    motor:
      logs?.filter((l) => isFullWash(l) && l.vehicle_type === "motor").length ||
      0,
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
        .select(
          "vehicle_type, vehicle_size, service_category, employee_id, price, bonus_amount, payroll_value",
        )
        .gte("created_at", startDate)
        .lte("created_at", endDate);

      if (transError) throw transError;

      const compensationMap = await getCompensationMap();

      // Rekap payroll hanya mengambil transaksi full wash.
      // Non-target sengaja disaring keluar dari perhitungan gaji dan slip.
      // 4. Hitung rekap gaji per karyawan
      const recap = employees.map((emp) => {
        const empTrans = transactions.filter(
          (t) => t.employee_id === emp.id && isFullWash(t),
        );

        const m = empTrans.filter(
          (t) => t.vehicle_type.toLowerCase() === "mobil",
        ).length;
        const t = empTrans.filter(
          (t) => t.vehicle_type.toLowerCase() === "motor",
        ).length;
        const payrollTotal = empTrans.reduce((sum, transaction) => {
          const storedValue = Number(transaction.payroll_value);
          const fallbackValue = calculatePayrollValue(
            transaction.vehicle_type,
            transaction.vehicle_size,
            transaction.service_category || "fullwash",
            compensationMap,
          );

          return (
            sum +
            (hasStoredNumber(transaction.payroll_value)
              ? storedValue
              : fallbackValue)
          );
        }, 0);
        const bonusTotal = empTrans.reduce((sum, transaction) => {
          const storedBonus = Number(transaction.bonus_amount);
          const fallbackBonus = calculateBonus(
            transaction.vehicle_type,
            transaction.vehicle_size,
            transaction.service_category || "fullwash",
            compensationMap,
          );

          return (
            sum +
            (hasStoredNumber(transaction.bonus_amount)
              ? storedBonus
              : fallbackBonus)
          );
        }, 0);

        return {
          id: emp.id,
          name: emp.name,
          m,
          t,
          fullwash_total: empTrans.length,
          payroll_total: payrollTotal,
          daily_bonus_total: bonusTotal,
          final_salary: payrollTotal,
          target: {
            mobil: TARGET_MAP.mobil,
            motor: TARGET_MAP.motor,
            mobil_percent: getTargetProgress(m, TARGET_MAP.mobil),
            motor_percent: getTargetProgress(t, TARGET_MAP.motor),
          },
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

    const compensationMap = await getCompensationMap();

    // Ringkasan dashboard: full wash untuk target/payroll,
    // semua transaksi untuk operasional, dan non-target tetap terpisah.
    const fullWashData = data.filter(isFullWash);
    const mobil = fullWashData.filter((t) => t.vehicle_type === "mobil").length;
    const motor = fullWashData.filter((t) => t.vehicle_type === "motor").length;
    const allMobil = data.filter((t) => t.vehicle_type === "mobil").length;
    const allMotor = data.filter((t) => t.vehicle_type === "motor").length;
    const payrollEstimate = fullWashData.reduce((sum, t) => {
      const storedValue = Number(t.payroll_value);
      const fallbackValue = calculatePayrollValue(
        t.vehicle_type,
        t.vehicle_size,
        t.service_category || "fullwash",
        compensationMap,
      );

      return (
        sum + (hasStoredNumber(t.payroll_value) ? storedValue : fallbackValue)
      );
    }, 0);
    const bonusMobil = fullWashData
      .filter((t) => t.vehicle_type === "mobil")
      .reduce(
        (sum, t) =>
          sum +
          (hasStoredNumber(t.bonus_amount)
            ? Number(t.bonus_amount)
            : calculateBonus(
                t.vehicle_type,
                t.vehicle_size,
                t.service_category || "fullwash",
                compensationMap,
              )),
        0,
      );
    const bonusMotor = fullWashData
      .filter((t) => t.vehicle_type === "motor")
      .reduce(
        (sum, t) =>
          sum +
          (hasStoredNumber(t.bonus_amount)
            ? Number(t.bonus_amount)
            : calculateBonus(
                t.vehicle_type,
                t.vehicle_size,
                t.service_category || "fullwash",
                compensationMap,
              )),
        0,
      );
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
      summary: {
        mobil,
        motor,
        allMobil,
        allMotor,
        fullwash: fullWashData.length,
        payrollEstimate,
        bonusMobil,
        bonusMotor,
        mobilTarget: TARGET_MAP.mobil,
        motorTarget: TARGET_MAP.motor,
        mobilTargetPercent: getTargetProgress(mobil, TARGET_MAP.mobil),
        motorTargetPercent: getTargetProgress(motor, TARGET_MAP.motor),
        revenue,
        startTime,
        lastTime,
      },
      transactions: data.map((t) => ({
        id: t.id,
        time: new Date(t.created_at).toLocaleTimeString("id-ID", {
          hour: "2-digit",
          minute: "2-digit",
          timeZone: "Asia/Makassar",
        }),
        vehicle_type: t.vehicle_type,
        vehicle_size: t.vehicle_size || "sedang",
        service_category: t.service_category || "fullwash",
        vehicle_brand: t.vehicle_brand,
        status: t.status,
        employee_name: t.employee_name || t.employees?.name || "N/A",
        price: t.price,
        bonus_amount: hasStoredNumber(t.bonus_amount)
          ? Number(t.bonus_amount)
          : calculateBonus(
              t.vehicle_type,
              t.vehicle_size || "sedang",
              t.service_category || "fullwash",
              compensationMap,
            ),
        payroll_value: hasStoredNumber(t.payroll_value)
          ? Number(t.payroll_value)
          : calculatePayrollValue(
              t.vehicle_type,
              t.vehicle_size || "sedang",
              t.service_category || "fullwash",
              compensationMap,
            ),
        input_by: t.input_by || "staff",
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

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Pcc. S77 running on port ${PORT}`));
}
