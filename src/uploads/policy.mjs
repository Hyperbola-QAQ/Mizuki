// The Strapi local upload provider uses paths below /uploads/. Reject ambiguous
// encodings and traversal rather than forwarding user input to the CMS.
export function uploadPath(raw) {
  if (typeof raw !== "string" || raw.includes("%") || raw.includes("\\")) return null;
  const parts = raw.split("/");
  if (!parts.length || parts.some((part) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part) || part === "." || part === "..")) return null;
  const path = `/uploads/${parts.join("/")}`;
  return /\.(?:png|jpe?g|webp|avif|gif|svg|mp4|webm|mp3|ogg|wav|pdf)$/i.test(path) ? path : null;
}

function referencesBody(body, target, origin) {
  if (typeof body !== "string") return false;
  // Extract Markdown destinations and HTML src/href attributes. Matching is
  // against an entire parsed destination, not a substring or stale index.
  const refs = [];
  for (const match of body.matchAll(/!?\[[^\]]*\]\(\s*<?([^\s)>]+)>?(?:\s+[^)]*)?\)/g)) refs.push(match[1]);
  for (const match of body.matchAll(/\b(?:src|href|poster)\s*=\s*["']([^"']+)["']/gi)) refs.push(match[1]);
  const origins = Array.isArray(origin) ? origin : [origin];
  return refs.some((ref) => ref === target || origins.some((value) => ref === `${value}${target}`));
}

export function publiclyReferences(doc, target, origin) {
  const meta = doc?.metadata;
  if (!meta || typeof meta !== "object" || meta.draft || meta.encrypted || (meta.password !== undefined && String(meta.password).trim())) return false;
  const origins = Array.isArray(origin) ? origin : [origin];
  const matches = (ref) => ref === target || origins.some((value) => ref === `${value}${target}`);
  if (matches(meta.image)) return true;
  if (Array.isArray(meta.images) && meta.images.some((image) => image && matches(image.src))) return true;
  return referencesBody(doc.body, target, origin);
}
