// Uploads the extension's icon to its add-on record on addons.mozilla.org.
//
//   AMO_JWT_ISSUER=… AMO_JWT_SECRET=… node scripts/amo-icon.mjs
//
// Mozilla's signing upload (web-ext sign) carries the .xpi only; the icon
// the developer hub shows for the add-on is a separate field on the add-on
// record, so it is set here with the same API keys. For a self-distributed
// add-on the icon is seen only in the developer hub, so a failure is
// reported but does not fail the caller.

import { createHmac, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const issuer = process.env.AMO_JWT_ISSUER;
const secret = process.env.AMO_JWT_SECRET;
if (!issuer || !secret) {
	console.error('set AMO_JWT_ISSUER and AMO_JWT_SECRET (addons.mozilla.org › Tools › Manage API Keys)');
	process.exit(2);
}

const manifest = JSON.parse(await readFile(path.join(root, 'extension/manifests/firefox.json'), 'utf8'));
const addonId = manifest.browser_specific_settings.gecko.id;
const iconPath = path.join(root, 'extension/icons/icon128.png');

/** A short-lived HS256 token in the shape the AMO API expects. */
function jwt() {
	const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
	const now = Math.floor(Date.now() / 1000);
	const unsigned = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ iss: issuer, jti: randomUUID(), iat: now, exp: now + 60 })}`;
	const sig = createHmac('sha256', secret).update(unsigned).digest('base64url');
	return `${unsigned}.${sig}`;
}

const form = new FormData();
form.append('icon', new Blob([await readFile(iconPath)], { type: 'image/png' }), 'icon128.png');
const url = `https://addons.mozilla.org/api/v5/addons/addon/${encodeURIComponent(addonId)}/`;
const res = await fetch(url, { method: 'PATCH', headers: { Authorization: `JWT ${jwt()}` }, body: form });
if (!res.ok) {
	console.error(`icon upload for ${addonId} failed: ${res.status} ${await res.text()}`);
	process.exit(1);
}
const body = await res.json();
console.log(`icon set for ${addonId}: ${body.icon_url ?? body.icon ?? 'ok'}`);
