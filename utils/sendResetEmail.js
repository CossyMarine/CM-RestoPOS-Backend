// utils/sendResetEmail.js
import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

// sendResetEmail({ to, code, fullName })
const sendResetEmail = async ({ to, code, fullName }) => {
  const html = `
<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f4f7fb;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f7fb;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.08);">
          <tr>
            <td align="center" style="background:#f97316;padding:30px 20px;">
              <h1 style="color:#ffffff;margin:0;font-size:24px;">RestoPOS</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:36px 32px;">
              <h2 style="margin-top:0;color:#111827;font-size:22px;">Reset your password</h2>
              <p style="font-size:15px;line-height:1.6;color:#4b5563;">
                Hi ${fullName || "there"}, use the code below to reset your password. It expires in 10 minutes.
              </p>
              <div style="text-align:center;margin:28px 0;">
                <span style="display:inline-block;letter-spacing:8px;font-size:32px;font-weight:800;color:#f97316;background:#fff7ed;padding:16px 24px;border-radius:12px;">
                  ${code}
                </span>
              </div>
              <p style="font-size:13px;color:#6b7280;">
                If you didn't request this, you can safely ignore this email.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return resend.emails.send({
    from: "RestoPOS <noreply@restopos.online>", // replace with your verified Resend sending domain
    to,
    subject: "Your RestoPOS password reset code",
    text: `Your RestoPOS password reset code is ${code}. It expires in 10 minutes.`,
    html,
  });
};

export default sendResetEmail;
