// Dataset rows: one per channel (recordType "channel") and, on request, one per post (recordType "post").

export function buildChannelRow(result, { discoveredFrom = null, now = Date.now() } = {}) {
    const m = result.metrics ?? {};
    return {
        recordType: 'channel',
        username: result.username,
        url: `https://t.me/${result.username}`,
        status: result.status,
        statusDetail: result.statusDetail ?? null,
        kind: result.kind ?? null,
        title: result.title ?? null,
        description: result.description ?? null,
        verified: result.verified ?? null,
        members: result.members ?? null,
        memberLabel: result.memberLabel ?? null,
        photos: result.counters?.photos ?? null,
        videos: result.counters?.videos ?? null,
        links: result.counters?.links ?? null,
        postsSampled: m.postsSampled ?? 0,
        newestPostDate: m.newestPostDate ?? null,
        oldestPostDate: m.oldestPostDate ?? null,
        daysSinceLastPost: m.daysSinceLastPost ?? null,
        postsPerWeek: m.postsPerWeek ?? null,
        frequencyBasis: m.frequencyBasis ?? null,
        viewsPostsUsed: m.viewsPostsUsed ?? 0,
        medianViews: m.medianViews ?? null,
        meanViews: m.meanViews ?? null,
        minViews: m.minViews ?? null,
        maxViews: m.maxViews ?? null,
        medianViewsPctOfMembers: m.medianViewsPctOfMembers ?? null,
        forwardedPostsPct: m.forwardedPostsPct ?? null,
        mentionedAccounts: (m.mentionedAccounts ?? []).slice(0, 25),
        discoveredFrom,
        pagesFetched: result.pagesFetched ?? 0,
        scrapedAt: new Date(now).toISOString(),
    };
}

export function buildPostRow(post, channel) {
    return {
        recordType: 'post',
        channel: channel.username,
        postId: post.id,
        url: post.url,
        date: post.date,
        views: post.views,
        reactions: post.reactions,
        forwarded: post.forwarded,
        forwardedFrom: post.forwardedFrom,
        isReply: post.isReply,
        mediaTypes: post.mediaTypes,
        text: post.text,
        mentions: post.mentions,
    };
}

export function summarise(rows, { started, stoppedBecause, queuedLeft = 0, invalid = 0 }) {
    const channels = rows.filter((r) => r.recordType === 'channel');
    const byStatus = {};
    for (const r of channels) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    return {
        startedAt: started,
        finishedAt: new Date().toISOString(),
        channelsRequested: channels.length,
        channelsOk: byStatus.ok ?? 0,
        channelsFailed: channels.length - (byStatus.ok ?? 0) - (byStatus.filtered ?? 0),
        byStatus,
        invalidInputs: invalid,
        stoppedBecause,
        channelsNotReached: queuedLeft,
        note: 'Posting frequency and views come from the public preview t.me/s/<channel>. A figure is null when the page does not show it or fewer than 3 posts carry it. Views of posts younger than the "fresh" limit are left out of the view statistics.',
    };
}
