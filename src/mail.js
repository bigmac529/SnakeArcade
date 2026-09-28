"use strict";
// Outgoing email (verification and password reset links).
// - SMTP mode (SMTP_HOST set): authenticated SMTP, e.g. the socha3.com
//   mailbox: port 587 + STARTTLS (required, never plain text) or 465 + TLS.
// - Outbox mode (no SMTP_HOST, for local dev and tests): each message is
//   written as JSON to MAIL_OUTBOX_DIR instead of being sent.
// Logs only ever show masked addresses.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { maskEmail } = require("./validation");

function createMailer(mailConfig, { log = console.log } = {}) {
  let transport = null;
  if (mailConfig.mode === "smtp") {
    const nodemailer = require("nodemailer");
    transport = nodemailer.createTransport({
      host: mailConfig.host,
      port: mailConfig.port,
      secure: mailConfig.secure,
      requireTLS: !mailConfig.secure,
      auth: mailConfig.user ? { user: mailConfig.user, pass: mailConfig.password } : undefined,
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 20000
    });
  }

  async function send({ to, subject, text, html, kind }) {
    if (transport) {
      await transport.sendMail({
        from: mailConfig.from,
        replyTo: mailConfig.replyTo || undefined,
        to,
        subject,
        text,
        html
      });
      log(`[mail] sent ${kind} email to ${maskEmail(to)}`);
      return;
    }
    fs.mkdirSync(mailConfig.outboxDir, { recursive: true });
    const file = path.join(mailConfig.outboxDir, `${Date.now()}-${crypto.randomBytes(4).toString("hex")}-${kind}.json`);
    fs.writeFileSync(file, JSON.stringify({ to, from: mailConfig.from, subject, text, html, kind, at: new Date().toISOString() }, null, 2));
    log(`[mail] outbox: ${kind} email for ${maskEmail(to)} written to ${path.basename(file)}`);
  }

  async function verify() {
    if (transport) {
      await transport.verify();
    }
  }

  return { mode: mailConfig.mode, send, verify };
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function verificationEmail({ displayName, link, hours }) {
  return {
    kind: "verify",
    subject: "Confirm your SnakeArcade email",
    text: `Hi ${displayName},\n\nConfirm your email to start playing SnakeArcade and posting scores:\n${link}\n\nThe link works once and expires in ${hours} hours. If you didn't sign up, ignore this email.\n`,
    html: `<p>Hi ${escapeHtml(displayName)},</p><p>Confirm your email to start playing SnakeArcade and posting scores:</p><p><a href="${escapeHtml(link)}">Confirm my email</a></p><p>The link works once and expires in ${hours} hours. If you didn't sign up, ignore this email.</p>`
  };
}

function resetEmail({ displayName, link, minutes }) {
  return {
    kind: "reset",
    subject: "Reset your SnakeArcade password",
    text: `Hi ${displayName},\n\nSomeone asked to reset the password for your SnakeArcade account. To choose a new password, open:\n${link}\n\nThe link works once and expires in ${minutes} minutes. If this wasn't you, ignore this email; your password stays the same.\n`,
    html: `<p>Hi ${escapeHtml(displayName)},</p><p>Someone asked to reset the password for your SnakeArcade account.</p><p><a href="${escapeHtml(link)}">Choose a new password</a></p><p>The link works once and expires in ${minutes} minutes. If this wasn't you, ignore this email; your password stays the same.</p>`
  };
}

module.exports = { createMailer, verificationEmail, resetEmail };
