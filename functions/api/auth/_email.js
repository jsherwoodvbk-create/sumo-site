// functions/api/auth/_email.js — send the magic-link email via Resend.
// Helper (leading _, no onRequest) → never a URL. Reads RESEND_API_KEY (Cloudflare secret).
const FROM = 'Salt Stats & Sumo <sumo@stavesandhoop.com>';

export async function sendMagicLink(env, toEmail, link) {
  if (!env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is not set');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: FROM,
      to: [toEmail],
      subject: 'Your Salt Stats & Sumo login link',
      text: `Tap to log in to Salt Stats & Sumo:\n\n${link}\n\nThis link works for 15 minutes. If you didn't request it, you can ignore this email.`,
      html: `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;color:#3D2713">
  <h2 style="color:#8A2A20;margin:0 0 12px">🧂 Salt Stats &amp; Sumo</h2>
  <p style="margin:0 0 16px">Tap the button to log in:</p>
  <p style="margin:0 0 16px"><a href="${link}" style="display:inline-block;background:#8A2A20;color:#fff;text-decoration:none;padding:11px 22px;border-radius:8px;font-weight:600">Log in</a></p>
  <p style="font-size:13px;color:#8C7550;margin:0">This link works for 15 minutes. If you didn't request it, you can safely ignore this email.</p>
</div>`,
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Resend send failed ${res.status}: ${t.slice(0, 200)}`);
  }
  return true;
}
