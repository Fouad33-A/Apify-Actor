// SYNTHETIC HTML fixtures. They encode the DOM structure documented in the
// source-file header comments (instagram.js / facebook.js), NOT fresh captures
// of the real sites. Passing tests here proves the extraction logic handles
// that structure and its edge cases; it does not prove the real sites still
// look like this. Real-site validation needs a live run.

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");

// ---- Instagram ----

// Header order per instagram.js: username / full name / posts / followers /
// following / bio / external link. Each piece is its own block so innerText
// yields one line per piece.
export function igHeader({
  username = "nasa",
  fullName = "NASA",
  verified = true,
  posts = ["4,000", null],
  followers = ["104M", "104,333,810"],
  following = ["70", null],
  bioLines = ["Exploring the universe", "and our home planet."],
  links = [],
  moreLine = null,
  extra = "",
} = {}) {
  const stat = ([shown, exact], label) =>
    `<li><span>${exact ? `<span title="${exact}">${shown}</span>` : `<span>${shown}</span>`} ${label}</span></li>`;
  return `<header>
    <div>${esc(username)}${verified ? '<svg aria-label="Verified" width="8" height="8"></svg>' : ""}</div>
    ${fullName ? `<div>${esc(fullName)}</div>` : ""}
    <ul>${stat(posts, "posts")}${stat(followers, "followers")}${stat(following, "following")}</ul>
    ${bioLines.map((l) => `<div>${esc(l)}</div>`).join("")}
    ${links.map((h) => `<div><a href="${h}">${h}</a></div>`).join("")}
    ${moreLine ? `<div>${esc(moreLine)}</div>` : ""}
    ${extra}
  </header>`;
}

export function igGrid(posts) {
  return `<main>${posts
    .map((p) => `<a href="${p.href}">${p.alt === undefined ? "" : `<img alt="${esc(p.alt)}" src="data:,">`}</a>`)
    .join("")}</main>`;
}

export const igPage = (inner) => `<!doctype html><html><body>${inner}</body></html>`;

// One comment. `time` is 6 ancestors below the block li, as instagram.js expects.
export function igComment({ user, ago = "2d", iso = "2026-09-01T10:00:00.000Z", body, likes = null, reply = true }) {
  return `<li>
    <div><span>${esc(user)}</span></div>
    <div>
      <div><div><div><div><time datetime="${iso}">${ago}</time></div></div></div></div>
      <div>${esc(body)}</div>
      ${likes ? `<div>${likes} likes</div>` : ""}
      ${reply ? "<div>Reply</div>" : ""}
    </div>
  </li>`;
}

export function igPost({ postIso = "2026-09-20T12:00:00.000Z", likes = null, views = null, comments = [] } = {}) {
  return igPage(`<article>
    <div><time datetime="${postIso}">5d</time></div>
    ${likes ? `<section><span>${likes}</span></section>` : ""}
    ${views ? `<section><span>${views}</span></section>` : ""}
    <ul>${comments.join("")}</ul>
  </article>`);
}

// ---- Facebook ----

// Intro card order per facebook.js: name, stats line, action buttons, bio, category.
export function fbPage({
  name = "NASA",
  stats = "28M followers • 52 following",
  buttons = ["Follow", "Message"],
  bioLines = ["Explore the universe and discover our home planet."],
  category = "Government organization",
  verified = true,
  links = [],
} = {}) {
  const linksSection = links.length
    ? `<section><div><div><div><div><span>Links</span></div></div></div></div>${links
        .map((u) => `<a href="https://l.facebook.com/l.php?u=${encodeURIComponent(u)}&h=AT0abc">${esc(u)}</a>`)
        .join("")}</section>`
    : "";
  return `<!doctype html><html><body><div role="main">
    <div>
      <div>${esc(name)}${verified ? "<svg><title>Verified account</title></svg>" : ""}</div>
      ${stats ? `<div>${esc(stats)}</div>` : ""}
      <div>${buttons.map((b) => `<div role="button">${esc(b)}</div>`).join("")}</div>
      ${bioLines.map((l) => `<div>${esc(l)}</div>`).join("")}
      ${category ? `<div><div role="button">${esc(category)}</div></div>` : ""}
    </div>
    ${linksSection}
  </div></body></html>`;
}
