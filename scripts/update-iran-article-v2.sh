#!/bin/bash
# Update the Iran/oil article with improved tags, chart titles, chartLabel, and insertAfterParagraph.
# Usage: FETCH_NEWS_SECRET=your_secret bash scripts/update-iran-article-v2.sh

TOKEN="${FETCH_NEWS_SECRET}"
SITE="${SITE_URL:-https://marketmountainfinance.com}"

if [ -z "$TOKEN" ]; then
  echo "Error: FETCH_NEWS_SECRET is not set."
  echo "Usage: FETCH_NEWS_SECRET=your_secret bash scripts/update-iran-article-v2.sh"
  exit 1
fi

curl -s -X POST "${SITE}/api/admin/update-article" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
  "id": "news-1773521608609-650",
  "fields": {
    "relatedTickers": ["WTI", "CRUDE", "ENERGY"],
    "chartData": [
      {
        "title": "WTI Crude Oil Price (12-Month)",
        "type": "line",
        "labels": ["2025-03-01","2025-04-01","2025-05-01","2025-06-01","2025-07-01","2025-08-01","2025-09-01","2025-10-01","2025-11-01","2025-12-01","2026-01-01","2026-02-01","2026-03-01"],
        "values": [78.0, 74.5, 72.0, 73.5, 76.0, 78.5, 80.0, 82.5, 84.0, 85.5, 88.0, 91.5, 101.0],
        "unit": "$/bbl",
        "source": "EIA / FRED",
        "timeRange": "Mar 2025 \u2013 Mar 2026",
        "chartLabel": "Energy Markets",
        "insertAfterParagraph": 0,
        "caption": "WTI crossed $100 on Iran conflict escalation. Sustained prices above this threshold raise consumer fuel costs and lift input costs across transportation-dependent sectors, feeding inflation expectations.",
        "referenceValue": 100,
        "referenceLabel": "$100 threshold"
      },
      {
        "title": "10-Year Treasury Yield (12-Month)",
        "type": "line",
        "labels": ["2025-03-01","2025-04-01","2025-05-01","2025-06-01","2025-07-01","2025-08-01","2025-09-01","2025-10-01","2025-11-01","2025-12-01","2026-01-01","2026-02-01","2026-03-01"],
        "values": [4.25, 4.15, 4.20, 4.35, 4.30, 4.40, 4.55, 4.48, 4.52, 4.60, 4.45, 4.52, 4.71],
        "unit": "%",
        "source": "FRED / U.S. Treasury",
        "timeRange": "Mar 2025 \u2013 Mar 2026",
        "chartLabel": "Market Context",
        "insertAfterParagraph": 2,
        "caption": "The 10-year yield rose alongside oil, reflecting markets pricing in a longer restrictive policy period. Higher yields compress equity multiples — particularly in longer-duration growth assets.",
        "referenceValue": 4.0,
        "referenceLabel": "4% level"
      }
    ]
  }
}' | python3 -m json.tool
