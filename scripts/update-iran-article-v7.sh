#!/bin/bash
# v7: Fix text/chart consistency — confirmed spot price is $98.7, not above $100.
# Softens headline, story opening, and key takeaways to match the chart endpoint.
# Usage: FETCH_NEWS_SECRET=your_secret bash scripts/update-iran-article-v7.sh

TOKEN="${FETCH_NEWS_SECRET}"
SITE="${SITE_URL:-https://marketmountainfinance.com}"

if [ -z "$TOKEN" ]; then
  echo "Error: FETCH_NEWS_SECRET is not set."
  exit 1
fi

curl -s -X POST "${SITE}/api/admin/update-article" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
  "id": "news-1773521608609-650",
  "fields": {
    "title": "Iran Conflict Pushes Oil Toward $100, Pressuring Equities and Rate Expectations",
    "story": "Oil prices surged toward the $100 per barrel threshold on Friday amid escalating tensions involving Iran and shipping risks in the Persian Gulf, marking one of the more significant energy supply disruptions in recent months. The move reflects genuine physical disruption to global crude flows rather than pure financial positioning. California refiners face particularly acute cost pressures as regional crude premiums have widened. The state'"'"'s isolated refining system and limited pipeline connections to other U.S. regions make it especially sensitive to Persian Gulf supply shocks, causing disruptions to transmit to pump prices faster than in most other areas of the country. This is not merely a commodity price event; it represents a repricing of inflation expectations and the terminal rate environment that underpins equity valuations across the market.\n\nEquity markets fell sharply as traders reassessed the inflation implications of sustained oil elevation. Stocks declined as uncertainty over regional energy supplies and geopolitical risk intensified, heightening concerns over fuel inflation and interest rates. The dollar strengthened simultaneously, reflecting safe-haven demand and the expectation that higher energy costs would compel central banks to maintain restrictive policy longer than previously priced.\n\nThe supply shock arrives at a critical juncture in the energy complex, with analysts reassessing crude price forecasts as rising regional tensions signal genuine supply uncertainty rather than temporary market volatility. The inflation transmission mechanism runs directly from oil prices to monetary policy expectations. Sustained crude near $100 raises consumer energy costs and lifts input costs across transportation-dependent sectors, creating upward pressure on inflation measures the Federal Reserve monitors most closely. Higher inflation expectations lead markets to price in a longer period of restrictive monetary policy. That shift in rate expectations ultimately pressures equity valuations.\n\nThe equity market reaction illustrates the second-order cost of elevated oil. Stocks did not simply fall on energy price concerns. They repriced on the assumption that central banks would need to maintain restrictive policy longer to contain second-round inflationary effects. Any sustained upward revision in rate expectations could compress equity multiples across growth and rate-sensitive sectors. Energy equities themselves may benefit from higher crude prices, but the broader market faces clear headwinds from the inflation-rate dynamic that oil shocks tend to create.\n\nThe critical forward signal is whether oil prices push through $100 and hold, or retreat toward $85\u201390. A sustained break above that threshold would likely pressure analysts to revise full-year inflation forecasts upward and extend the projected timeline for rate cuts, weighing further on equity valuations. Investors should monitor Persian Gulf shipping reports and regional energy flow data as leading indicators over the next two to four weeks."
  }
}' | python3 -m json.tool
