// ==========================================================
// LMX Studio — AI Image Designer Backend (FINAL DEPLOY BUILD)
// LMX Studio — AI Image Designer Backend (FINAL DEPLOY BUILD — PATCHED)
// ----------------------------------------------------------
// • POST /api/generate — Optimized OpenAI Image API (auto-retry)
// • POST /api/submit   — Sends generated image + form via Resend
@@ -65,7 +65,7 @@
          model: "gpt-image-1",
          prompt,
          size,
          quality: "standard",
          quality: "high", // ✅ replaced 'standard'
        },
        { signal: controller.signal }
      );
@@ -78,92 +78,92 @@
        model: "gpt-image-1",
        prompt,
        size,
        quality: "standard",
        quality: "high", // ✅ replaced 'standard'
      });
    }

    const b64 = result?.data?.[0]?.b64_json;
    if (!b64) return res.status(500).json({ error: "No image returned." });

    console.log(`✅ Image generated successfully (${size})`);
    res.json({ base64: `data:image/png;base64,${b64}` });
  } catch (err) {
    console.error("❌ GENERATE_ERR:", err.name, err.message);
    if (err.name === "AbortError") {
      return res
        .status(504)
        .json({ error: "Timed out — try a shorter or simpler prompt." });
    }
    res.status(500).json({ error: "Image generator unavailable." });
  }
});

// ===== ORDER SUBMISSION =====
app.post("/api/submit", upload.single("upload"), async (req, res) => {
  try {
    const f = req.body || {};
    const attachments = [];

    // ---- Generated image ----
    const gen = f.generatedImage || "";
    if (gen.startsWith("data:image/")) {
      const base64 = gen.split(",")[1];
      if (base64)
        attachments.push({
          filename: "generated.png",
          content: base64,
          encoding: "base64",
        });
    } else if (/^https?:/.test(gen)) {
      const r = await fetch(gen);
      if (r.ok) {
        const buf = Buffer.from(await r.arrayBuffer());
        attachments.push({
          filename: "generated.png",
          content: buf.toString("base64"),
          encoding: "base64",
        });
      }
    }

    // ---- Uploaded file ----
    if (req.file) {
      attachments.push({
        filename: req.file.originalname,
        content: req.file.buffer.toString("base64"),
        encoding: "base64",
      });
    }

    // ---- Email body ----
    const html = `
      <h2>🧩 New LMX AI Designer Submission</h2>
      <p><b>Name:</b> ${f.name || "N/A"}</p>
      <p><b>Email:</b> ${f.email || "N/A"}</p>
      <p><b>Product:</b> ${f.product || "N/A"}</p>
      <p><b>Qty:</b> ${f.qty || "N/A"}</p>
      <p><b>Size:</b> ${f.size || "N/A"}</p>
      <p><b>Color:</b> ${f.color || "N/A"}</p>
      <p><b>Notes:</b> ${f.notes || "None"}</p>
    `;

    await resend.emails.send({
      from: "LMX Studio <no-reply@lmxstudio.com>",
      to: [SUBMIT_TO],
      subject: "LMX — New AI Designer Submission",
      html,
      attachments,
    });

    console.log("📤 Email sent successfully to:", SUBMIT_TO);
    res.json({ ok: true });
  } catch (err) {
    console.error("❌ SUBMIT_ERR:", err);
    res.status(500).json({ error: "Submit failed. Please retry." });
  }
});

// ===== START SERVER =====
const PORT = process.env.PORT || 10000;
app.listen(PORT, () =>
  console.log(`✅ LMX backend live on port ${PORT} — ready for connections.`)