// Sends mail through Gmail SMTP using an App Password
const nodemailer = require('nodemailer');

let transporter;

function getTransporter() {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    throw new Error('GMAIL_USER and GMAIL_APP_PASSWORD must be set in .env');
  }
  if (!transporter) {
    transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD,
      },
    });
  }
  return transporter;
}

async function sendMail({ to, subject, text, attachmentPath, attachmentName }) {
  const mail = {
    from: `"${process.env.MY_NAME || process.env.GMAIL_USER}" <${process.env.GMAIL_USER}>`,
    to,
    subject,
    text,
  };
  if (attachmentPath) {
    mail.attachments = [{ filename: attachmentName || 'Resume.pdf', path: attachmentPath }];
  }
  return getTransporter().sendMail(mail);
}

async function verify() {
  await getTransporter().verify();
}

module.exports = { sendMail, verify };
