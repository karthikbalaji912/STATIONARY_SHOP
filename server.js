const path = require("path");
const dns = require("dns");

dns.setDefaultResultOrder("ipv4first");
require("dotenv").config();

const { TelegramBot } = require("node-telegram-bot-api");
const bot = new TelegramBot(process.env.BOT_TOKEN, {
    polling: false
});


const CHAT_ID = process.env.CHAT_ID;
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");

const app = express();

// CORS - configurable via env
const corsOptions = {
    origin: process.env.CORS_ORIGIN || '*',
    optionsSuccessStatus: 200
};
app.use(express.static(__dirname));
app.use(cors(corsOptions));
app.use(express.json());

/* ===========================
   MongoDB Connection
=========================== */

mongoose.connect(process.env.MONGO_URI)
.then(() => console.log("✅ MongoDB Connected"))
.catch(err => console.error(err));

/* ===========================
   Product Schema
=========================== */

const productSchema = new mongoose.Schema({
    shop_name:{
        type:String,
        default:"glory"
    },
    sku:{
        type:String,
        unique:true,
        required:true
    },
    name:{
        type:String,
        required:true
    },
    price:{
        type:Number,
        default:0
    },
    quantity:{
        type:Number,
        default:0
    },
    reorder_threshold:{
        type:Number,
        default:20
    },
    img:{
        type:String,
        default:""
    },
    sales: {
        type: [{
            date: String,
            amount: Number
        }],
        default: []
    }
},{
    timestamps:true
});

const Product = mongoose.model("Product", productSchema);

/* ===========================
   Payment Schema
=========================== */

const paymentSchema = new mongoose.Schema({
    shop_name: { type: String, default: "glory" },
    type: { type: String, enum: ["APS", "CASH", "GPAY"], required: true },
    amount: { type: Number, required: true },
    employee: { type: String, required: true },
    date: { type: Date, default: Date.now }
});

const Payment = mongoose.model("Payment", paymentSchema);

/* ===========================
   Daily Report Schema
=========================== */

const dailyReportSchema = new mongoose.Schema({
    shop_name: { type: String, default: "glory" },
    date: { type: String, required: true }, // YYYY-MM-DD
    totalRevenue: { type: Number, default: 0 },
    payments: {
        APS: { type: Number, default: 0 },
        CASH: { type: Number, default: 0 },
        GPAY: { type: Number, default: 0 }
    },
    details: { type: Object, default: {} } // optional extra info
});

const DailyReport = mongoose.model("DailyReport", dailyReportSchema);

/* ===========================
   GET ALL PRODUCTS
=========================== */

app.get("/api/products", async (req, res) => {
    try {
        const products = await Product.find().sort({ name: 1 });
        res.json(products);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/* ===========================
   ADD PRODUCT
=========================== */

app.post("/api/products", async (req, res) => {
    try {
        const exists = await Product.findOne({
            shop_name: req.body.shop_name,
            sku: req.body.sku
        });

        if (exists) {
            return res.json(exists);
        }

        const product = await Product.create({
            shop_name: req.body.shop_name,
            sku: req.body.sku,
            name: req.body.name,
            price: req.body.price || 0,
            quantity: req.body.quantity,
            reorder_threshold: req.body.reorder_threshold,
            img: req.body.img || "",
            sales: []
        });

        res.json(product);
    } catch (err) {
        if (err.code === 11000) {
            return res.status(400).json({ message: "SKU already exists" });
        }
        if (err.name === 'ValidationError') {
            return res.status(400).json({ message: err.message });
        }
        res.status(500).json({ error: err.message });
    }
});

/* ===========================
   UPDATE PRODUCT (name, threshold, price, img)
=========================== */

app.post("/api/products/:sku/update", async (req, res) => {
    try {
        const product = await Product.findOneAndUpdate(
            { sku: req.params.sku },
            {
                name: req.body.name,
                reorder_threshold: req.body.reorder_threshold,
                price: req.body.price,
                img: req.body.img
            },
            { new: true, runValidators: true }
        );
        if (!product) {
            return res.status(404).json({ message: "Product not found" });
        }
        res.json(product);
    } catch (err) {
        if (err.name === 'ValidationError') {
            return res.status(400).json({ message: err.message });
        }
        res.status(500).json({ error: err.message });
    }
});

/* ===========================
   STOCK ADJUST (delta + / -)
=========================== */

app.post("/api/products/:sku/adjust", async (req, res) => {
    try {
        const delta = Number(req.body.delta);
        if (isNaN(delta)) {
            return res.status(400).json({ message: "Invalid delta value" });
        }

        const product = await Product.findOne({ sku: req.params.sku });
        if (!product) {
            return res.status(404).json({ message: "Product not found" });
        }

        const newQuantity = product.quantity + delta;
        if (newQuantity < 0) {
            return res.status(400).json({
                message: `Cannot adjust below zero. Current stock: ${product.quantity}, attempted delta: ${delta}`
            });
        }

        product.quantity = newQuantity;

        if (delta < 0) {
            product.sales.push({
                date: new Date().toISOString().slice(0, 10),
                amount: req.body.amount || product.price
            });
        }

        await product.save();
const previousQuantity = product.quantity - delta;

if (
    product.quantity === 0 &&
    previousQuantity > 0
) {
    await sendOutOfStockAlert(product);
}
else if (
    previousQuantity > product.reorder_threshold &&
    product.quantity <= product.reorder_threshold
) {
    await sendLowStockAlert(product);
}
        res.json(product);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/* ===========================
   DELETE PRODUCT
=========================== */

app.delete("/api/products/:sku", async (req, res) => {
    try {
        const result = await Product.deleteOne({ sku: req.params.sku });
        if (result.deletedCount === 0) {
            return res.status(404).json({ message: "Product not found" });
        }
        res.json({ message: "Deleted" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/* ===========================
   PAYMENTS - GET
=========================== */

app.get("/api/payments", async (req, res) => {
    try {
        const payments = await Payment.find({ shop_name: "glory" }).sort({ date: -1 });
        res.json(payments);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/* ===========================
   PAYMENTS - POST
=========================== */

app.post("/api/payments", async (req, res) => {
    try {
        const { type, amount, employee } = req.body;
        if (!type || !amount || !employee) {
            return res.status(400).json({ message: "Missing fields" });
        }
        const payment = await Payment.create({
            shop_name: "glory",
            type,
            amount,
            employee
        });
        res.json(payment);
    } catch (err) {
        if (err.name === 'ValidationError') {
            return res.status(400).json({ message: err.message });
        }
        res.status(500).json({ error: err.message });
    }
});

/* ===========================
   CLOSE SHOP (Daily Report)
=========================== */

app.post("/api/close-shop", async (req, res) => {
    try {
const {
    shop_name = "glory",
    date,
    totalRevenue,
    payments,
    details,
    productsSold,
    lowStockCount,
    outOfStockCount
} = req.body;
        const reportDate = date || new Date().toISOString().slice(0, 10);

        // Check if report already exists for this date
        let report = await DailyReport.findOne({ shop_name, date: reportDate });
        if (report) {
            // update existing
            report.totalRevenue = totalRevenue || 0;
            report.payments = {
                APS: payments?.APS ?? 0,
                CASH: payments?.CASH ?? 0,
                GPAY: payments?.GPAY ?? 0
            };
            report.details = details || {};
            await report.save();
        } else {
            report = await DailyReport.create({
                shop_name,
                date: reportDate,
                totalRevenue: totalRevenue || 0,
                payments: {
                    APS: payments?.APS ?? 0,
                    CASH: payments?.CASH ?? 0,
                    GPAY: payments?.GPAY ?? 0
                },
                details: details || {}
            });
        }

        console.log("✅ Daily Report saved:", report);
        await sendClosingReport({
    totalRevenue,
    payments,
    productsSold,
    lowStockCount,
    outOfStockCount
});
        res.json({ success: true, report });
    } catch (err) {
        console.error("Close shop error:", err);
        res.status(500).json({ error: err.message });
    }
});

/* ===========================
   DATE & TIME HELPER
=========================== */

function getCurrentDateTime() {
    const now = new Date();

    const date = now.toLocaleDateString("en-GB").replace(/\//g, "-");

    const time = now.toLocaleTimeString("en-IN", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: true
    });

    return { date, time };
}

/* ===========================
   TELEGRAM
=========================== */

async function sendTelegramMessage(message) {
    try {
        await bot.sendMessage(CHAT_ID, message, {
            parse_mode: "HTML"
        });

        console.log("✅ Telegram message sent");
    } catch (error) {
        console.error("❌ Full Telegram Error:");
        console.error(error);

        if (error.cause) {
            console.error("Cause:", error.cause);
        }

        if (error.response) {
            console.error("Response:", error.response.body);
        }
    }
}

/* ===========================
   LOW STOCK ALERT
=========================== */

async function sendLowStockAlert(product) {
    const { date, time } = getCurrentDateTime();

    await sendTelegramMessage(`
⚠️ <b>LOW STOCK ALERT</b>

🏪 <b>Friendz Shop</b>

📦 <b>Product :</b> ${product.name}
🔖 <b>SKU :</b> ${product.sku}
📉 <b>Stock Left :</b> ${product.quantity}
⚠️ <b>Reorder Level :</b> ${product.reorder_threshold}

━━━━━━━━━━━━━━━━━━━━━━
🕒 <b>Time :</b> ${time}
📅 <b>Date :</b> ${date}
━━━━━━━━━━━━━━━━━━━━━━
🤖 <b>Friendz Shop Notification System</b>
`);
}

/* ===========================
   OUT OF STOCK ALERT
=========================== */

async function sendOutOfStockAlert(product) {
    const { date, time } = getCurrentDateTime();

    await sendTelegramMessage(`
❌ <b>OUT OF STOCK</b>

🏪 <b>Friendz Shop</b>

📦 <b>Product :</b> ${product.name}
🔖 <b>SKU :</b> ${product.sku}

🚫 <b>Stock Left :</b> 0
🛒 <b>Please Restock Immediately</b>

━━━━━━━━━━━━━━━━━━━━━━
🕒 <b>Time :</b> ${time}
📅 <b>Date :</b> ${date}
━━━━━━━━━━━━━━━━━━━━━━
🤖 <b>Friendz Shop Notification System</b>
`);
}

/* ===========================
   DAILY CLOSING REPORT
=========================== */

async function sendClosingReport({
    totalRevenue,
    payments,
    productsSold,
    lowStockCount,
    outOfStockCount
}) {
    const { date, time } = getCurrentDateTime();

    await sendTelegramMessage(`
🏪 <b>FRIENDZ SHOP</b>
📊 <b>DAILY CLOSING REPORT</b>

💰 <b>Total Revenue :</b> ₹${totalRevenue}
💵 <b>Cash :</b> ₹${payments.CASH}
📱 <b>GPay :</b> ₹${payments.GPAY}
💳 <b>APS :</b> ₹${payments.APS}

📦 <b>Products Sold :</b> ${productsSold}
📉 <b>Low Stock Items :</b> ${lowStockCount}
❌ <b>Out of Stock :</b> ${outOfStockCount}

✅ <b>Shop Closed Successfully</b>

━━━━━━━━━━━━━━━━━━━━━━
🕒 <b>Time :</b> ${time}
📅 <b>Date :</b> ${date}
━━━━━━━━━━━━━━━━━━━━━━
🤖 <b>Friendz Shop Notification System</b>
`);
}

sendTelegramMessage(`
🎉 <b>WELCOME MR. BALAJI</b>

🏪 <b>Friendz Stationery Shop</b>

✅ Telegram Notification System Connected Successfully

📢 Your shop is now ready to receive:

📦 Product Alerts
⚠️ Low Stock Alerts
❌ Out of Stock Alerts
📊 Daily Closing Reports

🚀 Have a Great Business Day!

━━━━━━━━━━━━━━━━━━━━━━
🤖 <b>Friendz Shop Notification System</b>
`);
/* ===========================
   GET DAILY REPORTS (optional)
=========================== */

app.get("/api/daily-reports", async (req, res) => {
    try {
        const reports = await DailyReport.find({ shop_name: "glory" }).sort({ date: -1 });
        res.json(reports);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/* ===========================
   TEST
=========================== */

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

/* ===========================
   START SERVER
=========================== */

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`🚀 Server Running : http://localhost:${PORT}`);
});