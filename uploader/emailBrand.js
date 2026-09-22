// Cenas IT brand tokens — shared across transactional emails.
// Portado de service-catalog/supabase/functions/_shared/emailBrand.ts
// (mismo kit de marca, version CommonJS/Node en vez de Deno/TS).

const B = {
  primary:  '#0B192C',
  accent:   '#06B6D4',
  surface:  '#1E293B',
  textMain: '#334155',
  textMid:  '#64748B',
  textSoft: '#94A3B8',
  bg:       '#F8FAFC',
  border:   '#E2E8F0',
};

const EMAIL_FONT = "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

const LOGO_URL = process.env.LOGO_URL || 'https://cenas.uy/assets/brand/logo-badge-light.png';

function emailLogo(companyName = 'Cenas IT', height = 28) {
  return `<img src="${LOGO_URL}" alt="${companyName}" width="auto" height="${height}" style="display:block;height:${height}px;width:auto;border:0;" />`;
}

// Wrapper externo — max-width 600, fondo blanco, tipografia de marca.
// Usa <table> por compatibilidad con Outlook/Gmail — nada de display:flex.
function emailWrap(content) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${B.bg};font-family:${EMAIL_FONT};">
  <tr>
    <td align="center" style="padding:32px 24px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:12px;border:1px solid ${B.border};">
        <tr>
          <td style="padding:28px;">
            ${content}
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>`;
}

const LABEL_COLORS = {
  success: { text: '#059669', bg: '#ECFDF5', border: '#A7F3D0' },
  warning: { text: '#B45309', bg: '#FFFBEB', border: '#FDE68A' },
  error:   { text: '#DC2626', bg: '#FEF2F2', border: '#FECACA' },
  info:    { text: '#0E7490', bg: '#ECFEFF', border: '#A5F3FC' },
  cyan:    { text: '#0E7490', bg: '#ECFEFF', border: '#A5F3FC' },
  purple:  { text: '#6D28D9', bg: '#F5F3FF', border: '#DDD6FE' },
  default: { text: '#334155', bg: '#F1F5F9', border: '#CBD5E1' },
};

function resolveLabel(accentColor) {
  const map = {
    '#10b981': 'success', '#059669': 'success', '#34d399': 'success',
    '#f59e0b': 'warning', '#fbbf24': 'warning', '#b45309': 'warning',
    '#ef4444': 'error',   '#dc2626': 'error',
    '#06b6d4': 'cyan',    '#0e7490': 'cyan',
    '#8b5cf6': 'purple',  '#6d28d9': 'purple',
  };
  const key = map[accentColor.toLowerCase()];
  return LABEL_COLORS[key || 'default'];
}

// Franja de encabezado — logo/marca a la izquierda, badge de color a la derecha.
function emailHeader({ logoHtml, senderName, label, accentColor, title, subtitle }) {
  const pair = resolveLabel(accentColor);
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid ${B.border};">
      <tr>
        <td valign="middle">
          <table role="presentation" cellpadding="0" cellspacing="0">
            <tr>
              <td valign="middle" style="padding-right:10px;">
                <div style="background:${B.primary};padding:7px 13px;border-radius:7px;display:inline-block;">
                  <span style="color:${B.accent};font-size:11px;font-weight:700;letter-spacing:.5px;">${senderName.toUpperCase()}</span>
                </div>
              </td>
              ${logoHtml ? `<td valign="middle">${logoHtml}</td>` : ''}
            </tr>
          </table>
          ${title ? `<div style="font-size:16px;font-weight:700;color:${B.primary};margin-top:8px;">${title}</div>` : ''}
          ${subtitle ? `<div style="font-size:12px;color:${B.textMid};margin-top:2px;">${subtitle}</div>` : ''}
        </td>
        <td valign="middle" align="right">
          <table role="presentation" cellpadding="0" cellspacing="0" style="background:${pair.bg};border:1px solid ${pair.border};border-radius:8px;">
            <tr>
              <td style="padding:4px 12px;">
                <span style="color:${pair.text};font-size:11px;font-weight:700;letter-spacing:.5px;">${label}</span>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>`;
}

// Linea de pie institucional — la misma en todos los emails transaccionales.
function emailFooter() {
  return `<p style="color:${B.textSoft};font-size:10px;text-align:center;margin-top:12px;">
    Cenas IT Solutions &mdash; Procesos bajo norma ISO/IEC 20000
  </p>`;
}

module.exports = { B, EMAIL_FONT, LOGO_URL, emailLogo, emailWrap, emailHeader, emailFooter };
