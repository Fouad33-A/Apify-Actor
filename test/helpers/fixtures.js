// SYNTHETIC HTML fixtures. They encode the DOM structure documented in the
// source-file header comments (instagram.js / facebook.js), NOT fresh captures
// of the real sites. Passing tests here proves the extraction logic handles
// that structure and its edge cases; it does not prove the real sites still
// look like this. Real-site validation needs a live run.

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

// ---- Instagram ----

// Header order per instagram.js: username / full name / posts / followers /
// following / bio / external link. Each piece is its own block so innerText
// yields one line per piece.
export function igHeader({
    username = 'nasa',
    fullName = 'NASA',
    verified = true,
    posts = ['4,000', null],
    followers = ['104M', '104,333,810'],
    following = ['70', null],
    bioLines = ['Exploring the universe', 'and our home planet.'],
    links = [],
    moreLine = null,
    extra = '',
} = {}) {
    const stat = ([shown, exact], label) =>
        `<li><span>${exact ? `<span title="${exact}">${shown}</span>` : `<span>${shown}</span>`} ${label}</span></li>`;
    return `<header>
    <div>${esc(username)}${verified ? '<svg aria-label="Verified" width="8" height="8"></svg>' : ''}</div>
    ${fullName ? `<div>${esc(fullName)}</div>` : ''}
    <ul>${stat(posts, 'posts')}${stat(followers, 'followers')}${stat(following, 'following')}</ul>
    ${bioLines.map((l) => `<div>${esc(l)}</div>`).join('')}
    ${links.map((h) => `<div><a href="${h}">${h}</a></div>`).join('')}
    ${moreLine ? `<div>${esc(moreLine)}</div>` : ''}
    ${extra}
  </header>`;
}

export function igGrid(posts) {
    return `<main>${posts
        .map((p) => `<a href="${p.href}">${p.alt === undefined ? '' : `<img alt="${esc(p.alt)}" src="data:,">`}</a>`)
        .join('')}</main>`;
}

export const igPage = (inner) => `<!doctype html><html><body>${inner}</body></html>`;

// One comment. `time` is 6 ancestors below the block li, as instagram.js expects.
export function igComment({ user, ago = '2d', iso = '2026-09-01T10:00:00.000Z', body, likes = null, reply = true }) {
    return `<li>
    <div><span>${esc(user)}</span></div>
    <div>
      <div><div><div><div><time datetime="${iso}">${ago}</time></div></div></div></div>
      <div>${esc(body)}</div>
      ${likes ? `<div>${likes} likes</div>` : ''}
      ${reply ? '<div>Reply</div>' : ''}
    </div>
  </li>`;
}

export function igPost({
    postIso = '2026-09-20T12:00:00.000Z',
    likes = null,
    views = null,
    comments = [],
    ogDescription = null,
} = {}) {
    return `<!doctype html><html><head>${
        ogDescription ? `<meta property="og:description" content="${esc(ogDescription)}">` : ''
    }</head><body><article>
    <div><time datetime="${postIso}">5d</time></div>
    ${likes ? `<section><span>${likes}</span></section>` : ''}
    ${views ? `<section><span>${views}</span></section>` : ''}
    <ul>${comments.join('')}</ul>
  </article></body></html>`;
}

// The public embed page: profile facts as a JSON string argument, exactly the shape seen live.
export function igEmbedPage(context) {
    const inner = JSON.stringify({ context });
    return `<!doctype html><html><body><div>${esc(context?.username ?? '')}</div>
    <script>requireLazy(["x"], function(){ return {"isProfileEmbed":true,"contextJSON":${JSON.stringify(inner)},"z":1}; });</script>
    </body></html>`;
}

// ---- Facebook ----

// Mirrors the structure of a real Page captured by a live DOM outline (2026-09-29): <h1>, follower/following
// links with <strong> counts, an Intro <span>bio</span> + <ul> (category button, email text, l.php links),
// and [role=article] posts with nested comment articles. Still synthetic content, real shape.
export const fbComment = ({ author, text, ago = '20h', likes = null, reply = false, to = 'Someone' }) =>
    `<div role="article" aria-label="${reply ? `Reply by ${author} to ${to}'s comment ${ago} ago` : `Comment by ${author} ${ago} ago`}">
        <div><div><div><a role="link" href="https://www.facebook.com/${author.replace(/\s/g, '.').toLowerCase()}?comment_id=1">${esc(author)}</a>
        <div>${esc(text)}</div></div>
        <div><a role="link" href="https://www.facebook.com/reel/1/?comment_id=1">${ago}</a>${likes ? `<div role="button" aria-label="${likes} reactions">${likes}</div>` : ''}</div></div></div>
    </div>`;

export const fbPost = ({
    url = 'https://www.facebook.com/reel/28263630716612782/?__cft__[0]=AZg0M1R5&__tn__=x',
    ago = '1d',
    caption = 'What happens when we detect an asteroid that could pose a threat to Earth?',
    truncated = true,
    reactions = '1.7K',
    comments = [],
} = {}) => `<div role="article"><div><div>
    <div><span><a role="link" href="https://www.facebook.com/NASA?__cft__[0]=x"><span>NASA</span></a></span>
      <span><span>a day ago</span><a role="link" aria-label="${ago}" href="${url}">${ago}</a></span></div>
    ${caption === null ? '' : `<div>${esc(caption)}${truncated ? ' … <div role="button">See more</div>' : ''}</div>`}
    <div><div><div>All reactions:</div><span>${reactions}</span></div><div role="button"><span>92</span></div><div role="button"><span>159</span></div></div>
    ${comments.join('')}
  </div></div></div>`;

export function fbPage({
    name = 'NASA - National Aeronautics and Space Administration',
    followers = '28M',
    following = '52',
    bio = 'Explore the universe and discover our home planet.',
    category = 'Government organization',
    verified = true,
    email = 'public-inquiries@hq.nasa.gov',
    links = [],
    ogDescription = null,
    posts = [],
    personalProfile = false,
} = {}) {
    const linkItems = links
        .map(
            (u) =>
                `<div><a role="link" href="https://l.facebook.com/l.php?u=${encodeURIComponent(u)}&h=AUDL"><span>${esc(u.replace(/^https?:\/\//, ''))}</span></a></div>`,
        )
        .join('');
    const introList =
        category || email || links.length
            ? `<ul>${category ? `<div><div role="button"><span>· ${esc(category)}<strong>Page</strong></span></div></div>` : ''}${
                  email ? `<div><span>${esc(email)}</span></div>` : ''
              }${linkItems}</ul>`
            : '';
    return `<!doctype html><html><head>${
        ogDescription ? `<meta property="og:description" content="${esc(ogDescription)}">` : ''
    }</head><body><div role="main">
    <div><div><div>
      <h1>${esc(name)}</h1>${verified ? '<svg><title>Verified account</title></svg>' : ''}
      <span> • ${
          personalProfile
              ? '1,234 friends'
              : `<a role="link" href="https://www.facebook.com/NASA/followers/"><strong>${followers}</strong> followers</a> <a role="link" href="https://www.facebook.com/NASA/following/"><strong>${following}</strong> following</a>`
      }</span>
    </div></div></div>
    <div><div role="tablist"><a role="tab" href="/NASA/"><span>Posts</span></a><a role="tab" href="/NASA/about"><span>About</span></a></div></div>
    <div><div><div><div><span>Intro</span></div><div>${bio ? `<span>${esc(bio)}</span>` : ''}${introList}</div></div></div>
      <footer role="contentinfo"><ul><li><a href="/privacy">Privacy</a></li></ul></footer>
    </div>
    <div>${posts.join('')}</div>
  </div></body></html>`;
}
