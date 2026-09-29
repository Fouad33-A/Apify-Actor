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

// The REAL profile header layout (captured live 2026-09-29): stats as links with the exact count in a title,
// then a block with display name, a Threads link repeating the username, the bio as a role=button and a link line.
export function igHeaderReal({
    username = 'nasa',
    fullName = 'NASA',
    followers = ['104M', '104,320,207'],
    following = '89',
    bio = 'Making the seemingly impossible, possible. \u2728',
    linkLine = 'www.nasa.gov and 4 more',
    verified = true,
    ogDescription = '104M Followers, 93 Following, 4,937 Posts - See Instagram photos and videos from NASA (@nasa)',
} = {}) {
    return `<!doctype html><html><head>${
        ogDescription ? `<meta property="og:description" content="${esc(ogDescription)}">` : ''
    }</head><body><main role="main"><div>
    <header>
      <div><div><span>${esc(username)}</span>${verified ? '<svg aria-label="Verified" width="8" height="8"></svg>' : ''}</div></div>
      <ul>
        <a role="link" href="#" style="display:block"><span><span title="${followers[1]}"><span>${followers[0]}</span></span> followers</span></a>
        <a role="link" href="#" style="display:block"><span><span>${following}</span> following</span></a>
      </ul>
      <div><div>
        <span style="display:block">${esc(fullName)}</span>
        <a role="link" href="https://www.threads.com/@${username}?xmt=x" style="display:block"><span>${esc(username)}</span></a>
        ${bio ? `<div role="button"><span>${esc(bio)}</span></div>` : ''}
        ${linkLine ? `<div><span>${esc(linkLine)}</span></div>` : ''}
      </div></div>
      <div role="menu"><div role="presentation"><ul><a role="link" aria-label="View Roman highlight" href="/stories/highlights/1/"><div role="button"><span>Roman</span></div></a></ul></div></div>
    </header>
    <div><div role="button"><span>Show more posts from ${esc(username)}</span></div></div>
  </div></main></body></html>`;
}

// Comments as on the real post page: username link, a time link, the text, Like / Reply; all comments share one list container.
export const igCommentReal = ({
    user,
    ago = '1h',
    iso = '2026-09-29T19:54:17.000Z',
    text,
    likes = null,
}) => `<div><div><div>
    <div><a role="link" href="/${user}/" style="display:block"><span>${esc(user)}</span></a><a role="link" href="/p/X/c/1/" style="display:block"><time title="Sep 29, 2026" datetime="${iso}">${ago}</time></a></div>
    <span>${esc(text)}</span></div>
    <div>${likes ? `<span>${likes} likes</span>` : '<span>Like</span>'}<div role="button"><span>Reply</span></div></div></div></div>`;

export const igPostReal = ({ comments = [], ogDescription = null } = {}) =>
    `<!doctype html><html><head>${
        ogDescription ? `<meta property="og:description" content="${esc(ogDescription)}">` : ''
    }</head><body><main role="main"><div><div><div>
      <div><div><a role="link" href="/nasa/"><span>nasa</span></a><time title="Sep 10, 2026" datetime="2026-09-10T21:20:26.000Z">2w</time></div>
        <span>The post caption itself.</span></div>
    </div></div><div><div>${comments.join('')}</div></div></div></main></body></html>`;

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
export const fbComment = ({ author, text, ago = '20h', likes = null, reply = false, to = 'Someone', badge = null }) =>
    `<div role="article" aria-label="${reply ? `Reply by ${author} to ${to}'s comment ${ago} ago` : `Comment by ${author} ${ago} ago`}">
        <div><div>${badge ? `<div>${badge}</div>` : ''}<div><a role="link" href="https://www.facebook.com/${author.replace(/\s/g, '.').toLowerCase()}?comment_id=1">${esc(author)}</a>
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
    <div><div><div><div><span>Intro</span></div><div>${bio ? `<span>${esc(bio)}</span>` : ''}${introList ? `<div>${introList}</div>` : ''}</div></div></div>
      <footer role="contentinfo"><ul><li><a href="/privacy">Privacy</a></li></ul></footer>
    </div>
    <div>${posts.join('')}</div>
  </div></body></html>`;
}

// A card that is not a post: an event / "plans to go live" item (seen live as the first article on a Page).
export const fbEventCard = () => `<div role="article"><div><div>
    <div><span>plans to go live.</span><span>11 minutes ago</span><a role="link" aria-label="11m" href="https://www.facebook.com/events/1036015482730574/?__cft__[0]=x">11m</a></div>
    <div><span>Thu, Oct 1 at 9:20 AM EDT</span><span>NASA's SpaceX Crew-13 Launch</span><div>11 people interested</div></div>
    <div><div><div>All reactions:</div><span>20</span></div></div>
  </div></div></div>`;
