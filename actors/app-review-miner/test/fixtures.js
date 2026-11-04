// Apple customer-reviews feed (JSON) as returned by itunes.apple.com/<cc>/rss/customerreviews/...
export function appleFeed({ page = 1, last = 2, reviews = [], withAppEntry = true }) {
    const entries = [];
    if (withAppEntry && page === 1) {
        entries.push({
            'im:name': { label: 'Demo App' },
            id: { label: 'https://apps.apple.com/us/app/demo/id111111' },
        });
    }
    for (const r of reviews) {
        entries.push({
            author: { name: { label: r.author ?? 'someone' } },
            updated: { label: r.date },
            'im:rating': { label: String(r.rating) },
            'im:version': { label: r.version ?? '1.0' },
            id: { label: String(r.id) },
            title: { label: r.title ?? '' },
            content: { label: r.text, attributes: { type: 'text' } },
            'im:voteSum': { label: String(r.votes ?? 0) },
            'im:voteCount': { label: String(r.votes ?? 0) },
        });
    }
    return {
        feed: {
            entry: entries.length === 1 ? entries[0] : entries,
            link: [
                {
                    attributes: {
                        rel: 'self',
                        href: `https://itunes.apple.com/us/rss/customerreviews/page=${page}/id=111111/json`,
                    },
                },
                {
                    attributes: {
                        rel: 'last',
                        href: `https://itunes.apple.com/us/rss/customerreviews/page=${last}/id=111111/sortby=mostrecent/xml`,
                    },
                },
            ],
        },
    };
}
