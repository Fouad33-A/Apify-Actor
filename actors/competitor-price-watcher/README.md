## What does Competitor Price Watcher do?

Reads **public pricing pages** and returns every **plan with its price, billing period and the change since the last run**. Give it the pricing or product page of each competitor (for example an online exam-prep site), schedule it weekly on the Apify platform, and the dataset shows what went up, what went down, which plans are new and which disappeared. It needs **no login** and no browser, so it is fast and cheap. You also get Apify's scheduling, API access, integrations and monitoring.

## Why use Competitor Price Watcher?

- Keep an eye on competitor pricing without opening ten websites every week.
- See at a glance which plans changed (`changeStatus`: `increased`, `decreased`, `new_plan`, `gone`, `unchanged`).
- Feed the dataset into a sheet, a dashboard or an alert through Apify integrations.

## How to use Competitor Price Watcher

1. Open the **Input** tab and add the pricing pages in **Pricing pages**. You can give a competitor name with each address.
2. Run it once: every price is marked `first_run` and becomes the baseline.
3. Schedule it weekly. From the second run on, each price shows the previous price and the difference.

## Input

| Field                                | Meaning                                                                       |
| ------------------------------------ | ----------------------------------------------------------------------------- |
| `pages`                              | Pricing page addresses, optionally with a `name` for the competitor.          |
| `historyStoreName`, `updateHistory`  | Named store that remembers the last prices; switch saving off for a test run. |
| `delayBetweenPagesMs`, `concurrency` | How gently the pages are read.                                                |
| `proxyConfiguration`                 | Optional, only to reach a page from another country.                          |

## Output

One row per price (`recordType: "price"`) and one row per page (`recordType: "page"`):

```json
{
    "recordType": "price",
    "competitor": "revisionvillage",
    "plan": "Single Course Gold",
    "price": 249,
    "currency": "USD",
    "period": "once",
    "changeStatus": "decreased",
    "previousPrice": 279,
    "change": -30,
    "changePct": -10.8,
    "status": "ok",
    "scrapedAt": "2026-10-29T14:00:00.000Z"
}
```

You can download the dataset in various formats such as JSON, HTML, CSV, or Excel.

### Data table

| Field                                                  | Meaning                                                                       |
| ------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `plan`, `price`, `priceMax`, `currency`                | The plan label found next to the price; a range gives `price` and `priceMax`. |
| `period`, `unit`                                       | `month`, `year`, `week`, `day` or `once`; `subject`, `student` and similar.   |
| `startingAt`                                           | The page says "starting at" or "from".                                        |
| `changeStatus`, `previousPrice`, `change`, `changePct` | Comparison with the last successful read of the same page.                    |
| `status`                                               | `ok`, `no_price_found`, `blocked`, `not_found`, `http_error`, `error`.        |

## How much does it cost to watch competitor prices?

Each page is one plain HTTP request, so a weekly run of ten pages uses a fraction of a cent of compute.

## Tips and limits

- The Actor reads the prices in the HTML the site sends. A page drawn only by JavaScript returns `no_price_found`; pick another page of that site that shows the prices in the text.
- Plan names are the words next to a price, so they can be rough. The `context` field shows the text around each price.
- A page that answers with a bot check returns `blocked`. Nothing is solved or bypassed.
- Changes are compared with the last run that read the page successfully, so a blocked week does not reset the baseline.

## FAQ, disclaimers and support

Only public pages are read, and you are responsible for following each site's terms. Found a page that is read wrongly? Please open an issue in the Issues tab with the address.
