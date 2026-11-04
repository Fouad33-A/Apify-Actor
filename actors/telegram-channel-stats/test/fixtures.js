// Sample pages that follow the structure of Telegram's public preview (t.me/s/<name>) and profile card (t.me/<name>).

export function previewHtml({
    username = 'demo',
    title = 'Demo Channel',
    subscribers = '12.3K',
    posts = [],
    before = null,
    extraCounters = '',
}) {
    const wrap = posts
        .map(
            (p) => `
<div class="tgme_widget_message_wrap js-widget_message_wrap">
  <div class="tgme_widget_message text_not_supported_wrap js-widget_message" data-post="${username}/${p.id}">
    <div class="tgme_widget_message_bubble">
      ${p.forwardedFrom ? `<div class="tgme_widget_message_forwarded_from"><span class="tgme_widget_message_forwarded_from_name">${p.forwardedFrom}</span></div>` : ''}
      ${p.reply ? '<a class="tgme_widget_message_reply" href="#"></a>' : ''}
      ${p.photo ? '<a class="tgme_widget_message_photo_wrap" href="#"></a>' : ''}
      <div class="tgme_widget_message_text js-message_text">${p.text ?? ''}</div>
      ${p.reactions ? `<div class="tgme_widget_message_reactions"><span class="tgme_reaction"><i class="emoji">👍</i>${p.reactions}</span></div>` : ''}
      <div class="tgme_widget_message_info">
        ${p.views != null ? `<span class="tgme_widget_message_views">${p.views}</span>` : ''}
        <span class="tgme_widget_message_meta"><a class="tgme_widget_message_date" href="https://t.me/${username}/${p.id}"><time datetime="${p.date}">x</time></a></span>
      </div>
    </div>
  </div>
</div>`,
        )
        .join('\n');
    return `<html><body>
<div class="tgme_channel_info">
  <div class="tgme_channel_info_header">
    <div class="tgme_channel_info_header_title"><span>${title}</span></div>
    <div class="tgme_channel_info_header_username"><a href="https://t.me/${username}">@${username}</a></div>
  </div>
  <div class="tgme_channel_info_counters">
    <div class="tgme_channel_info_counter"><span class="counter_value">${subscribers}</span> <span class="counter_type">subscribers</span></div>
    <div class="tgme_channel_info_counter"><span class="counter_value">1.2K</span> <span class="counter_type">photos</span></div>
    ${extraCounters}
  </div>
  <div class="tgme_channel_info_description">Daily news &amp; offers</div>
</div>
<section class="tgme_channel_history js-message_history">
${before ? `<a class="tme_messages_more js-messages_more" href="/s/${username}?before=${before}" data-before="${before}"></a>` : ''}
${wrap}
</section></body></html>`;
}

export function profileCardHtml({ title = 'Demo', extra = '5 400 subscribers', description = 'About' }) {
    return `<html><body><div class="tgme_page">
<div class="tgme_page_title"><span dir="auto">${title}</span></div>
<div class="tgme_page_extra">${extra}</div>
<div class="tgme_page_description">${description}</div>
</div></body></html>`;
}

export function notFoundHtml() {
    return `<html><body><div class="tgme_page"><div class="tgme_page_title"><span>Telegram: Contact @nobody1</span></div>
<div class="tgme_page_description">If you have <strong>Telegram</strong>, you can contact @nobody1 right away.</div></div></body></html>`;
}
