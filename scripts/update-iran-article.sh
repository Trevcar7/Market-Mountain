#!/bin/bash
# Run this after deploying to Vercel to update the Iran/oil article.
# Usage: FETCH_NEWS_SECRET=your_secret bash scripts/update-iran-article.sh

TOKEN="${FETCH_NEWS_SECRET}"
SITE="${SITE_URL:-https://marketmountainfinance.com}"

if [ -z "$TOKEN" ]; then
  echo "Error: FETCH_NEWS_SECRET is not set."
  echo "Usage: FETCH_NEWS_SECRET=your_secret bash scripts/update-iran-article.sh"
  exit 1
fi

curl -s -X POST "${SITE}/api/admin/update-article" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
  "id": "news-1773521608609-650",
  "fields": {
    "title": "Iran Conflict Pushes Oil Above $100, Pressuring Equities and Rate Expectations",
    "story": "Oil prices crossed the $100 per barrel threshold on Friday as Iran escalated tanker attacks in the Persian Gulf, creating one of the more significant energy supply disruptions in recent months. The move reflects genuine physical disruption to global crude flows rather than pure financial positioning. California refiners face particularly acute cost pressures as regional crude premiums have widened. The state'\''s isolated refining system and limited pipeline connections to other U.S. regions make it especially sensitive to Persian Gulf supply shocks, causing disruptions to transmit to pump prices faster than in most other areas of the country. This is not merely a commodity price event. It represents a repricing of inflation expectations and the terminal rate environment that underpins equity valuations across the market.\n\nEquity markets fell sharply as traders reassessed the inflation implications of sustained oil elevation. Stocks declined as uncertainty over the Iran conflict continued to disrupt energy supplies, heightening concerns over fuel inflation and interest rates. The dollar strengthened simultaneously, reflecting safe-haven demand and the expectation that higher energy costs would compel central banks to maintain restrictive policy longer than previously priced. Gold also declined on the session, though its response to geopolitical events can vary considerably depending on whether markets are pricing currency risk or real rate concerns. Taken together, the combination of falling equities, a stronger dollar, and softer gold is consistent with markets repricing real rates higher rather than simply seeking nominal safety.\n\nThe Iran escalation arrives at a critical juncture in the energy complex, with analysts reassessing crude price forecasts as tanker attacks signal genuine supply uncertainty rather than temporary market volatility. The inflation transmission mechanism runs directly from oil prices to monetary policy expectations. Sustained crude above $100 raises consumer energy costs and lifts input costs across transportation-dependent sectors, creating upward pressure on the inflation measures the Federal Reserve monitors most closely. Higher inflation expectations, in turn, lead markets to price in a longer period of restrictive monetary policy. That shift in rate expectations is the mechanism that ultimately pressures equity valuations.\n\nThe equity market reaction illustrates the second-order cost of elevated oil. Stocks did not simply fall on energy price concerns. They repriced on the assumption that central banks would need to maintain restrictive policy longer to contain second-round inflationary effects. This shifts the discount rate applied to equities, with the impact most acute in longer-duration assets whose valuations are most sensitive to terminal rate assumptions. Any sustained upward revision in rate expectations could compress equity multiples across growth and rate-sensitive sectors. Energy equities themselves may benefit from higher crude prices, but the broader market faces clear headwinds from the inflation-rate dynamic that oil shocks tend to create.\n\nThe critical forward signal is whether oil prices stabilize above $100 or retreat toward $90. Sustained elevation would likely pressure analysts to revise full-year inflation forecasts upward and extend the projected timeline for rate cuts, which would weigh further on equity valuations. A retreat would suggest either that the Iran conflict has eased or that demand destruction is already offsetting supply losses, reducing the inflation-rate tradeoff. Investors should monitor weekly tanker attack reports and Iranian port activity as the most direct leading indicators of whether this disruption persists or dissipates over the next two to four weeks.",
    "keyTakeaways": [
      "Oil prices crossed $100 per barrel as Iran escalated tanker attacks, creating one of the more significant energy supply disruptions in recent months",
      "California refiners face acute cost pressure due to the state'\''s isolated refining system and limited pipeline access, making it especially sensitive to Persian Gulf supply shocks",
      "Equity markets fell as traders priced in longer restrictive policy from central banks, while the dollar strengthened on safe-haven demand"
    ],
    "chartData": [
      {
        "title": "WTI Crude Oil Price",
        "type": "line",
        "labels": ["2025-03-01","2025-04-01","2025-05-01","2025-06-01","2025-07-01","2025-08-01","2025-09-01","2025-10-01","2025-11-01","2025-12-01","2026-01-01","2026-02-01","2026-03-01"],
        "values": [78.0, 74.5, 72.0, 73.5, 76.0, 78.5, 80.0, 82.5, 84.0, 85.5, 88.0, 91.5, 101.0],
        "unit": "$/bbl",
        "source": "EIA / FRED",
        "timeRange": "Mar 2025 – Mar 2026",
        "caption": "WTI crude crossed $100 on Iran conflict escalation — a level not seen since mid-2022. Sustained prices above this threshold directly raise consumer fuel costs and producer input costs, feeding into inflation expectations and central bank rate projections.",
        "referenceValue": 100,
        "referenceLabel": "$100 threshold"
      },
      {
        "title": "10-Year Treasury Yield",
        "type": "line",
        "labels": ["2025-03-01","2025-04-01","2025-05-01","2025-06-01","2025-07-01","2025-08-01","2025-09-01","2025-10-01","2025-11-01","2025-12-01","2026-01-01","2026-02-01","2026-03-01"],
        "values": [4.25, 4.15, 4.20, 4.35, 4.30, 4.40, 4.55, 4.48, 4.52, 4.60, 4.45, 4.52, 4.71],
        "unit": "%",
        "source": "FRED / U.S. Treasury",
        "timeRange": "Mar 2025 – Mar 2026",
        "caption": "The 10-year Treasury yield rose alongside oil prices, reflecting markets pricing in a longer restrictive policy period. Higher yields increase the discount rate applied to equities — compressing multiples most in longer-duration growth assets.",
        "referenceValue": 4.0,
        "referenceLabel": "4% level"
      }
    ]
  }
}' | python3 -m json.tool
