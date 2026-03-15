#!/bin/bash
# One-time correction for article news-1773598101820-952
# Run: FETCH_NEWS_SECRET=<your-secret> bash scripts/correct-article.sh

set -e

SITE_URL="${SITE_URL:-https://marketmountainfinance.com}"
SECRET="${FETCH_NEWS_SECRET:?Error: FETCH_NEWS_SECRET env var is required}"

echo "Correcting article news-1773598101820-952 at $SITE_URL..."

PAYLOAD=$(cat <<'ENDJSON'
{
  "id": "news-1773598101820-952",
  "reason": "Editorial correction: fix metadata (category, sentiment, tickers, sources, charts, verifiedClaims, confidence) for article published with incoherent source grouping",
  "fieldUpdates": {
    "category": "earnings",
    "sentiment": "negative",
    "relatedTickers": ["HUM", "PRU", "EPAM"],
    "topicKey": "earnings",
    "confidenceScore": 0.65,
    "sourcesUsed": [
      {
        "title": "Is Prudential Financial (PRU) A Buy Despite The Downward Target Price Revision?",
        "url": "https://finance.yahoo.com/news/prudential-financial-pru-buy-despite-163159657.html",
        "source": "Yahoo Finance"
      },
      {
        "title": "Bernstein SocGen cuts Humana stock price target on Stars pressure",
        "url": "https://www.investing.com/news/analyst-ratings/bernstein-socgen-cuts-humana-stock-price-target-on-stars-pressure-93CH-4561479",
        "source": "Investing.com"
      },
      {
        "title": "Mizuho raises EPAM Systems stock price target to $200 on AI growth",
        "url": "https://www.investing.com/news/analyst-ratings/mizuho-raises-epam-systems-stock-price-target-to-200-on-ai-growth-93CH-4561053",
        "source": "Investing.com"
      }
    ],
    "verifiedClaims": [
      "Bernstein SocGen cut Humana's price target citing Stars pressure",
      "10-Year Treasury yield at 4.27% as of March 12, 2026",
      "Fed Funds Rate at 3.64%"
    ],
    "marketImpact": [
      { "asset": "HUM", "change": "-target cut", "direction": "down" },
      { "asset": "EPAM", "change": "+target raise", "direction": "up" },
      { "asset": "PRU", "change": "-target cut", "direction": "down" }
    ],
    "chartData": [
      {
        "title": "10-Year Treasury Yield",
        "type": "line",
        "labels": ["2026-02-25","2026-02-26","2026-02-27","2026-03-02","2026-03-03","2026-03-04","2026-03-05","2026-03-06","2026-03-09","2026-03-10","2026-03-11","2026-03-12"],
        "values": [4.05,4.02,3.97,4.05,4.06,4.09,4.13,4.15,4.12,4.15,4.21,4.27],
        "unit": "%",
        "source": "FRED — St. Louis Fed",
        "timeRange": "Last 2 weeks",
        "chartLabel": "RATES",
        "caption": "Treasury yields rose 22 basis points over two weeks to 4.27%, compressing equity valuations for lower-yielding healthcare names.",
        "insertAfterParagraph": 1
      },
      {
        "title": "S&P 500 Index",
        "type": "line",
        "labels": ["2026-02-26","2026-02-27","2026-03-02","2026-03-03","2026-03-04","2026-03-05","2026-03-06","2026-03-09","2026-03-10","2026-03-11","2026-03-12","2026-03-13"],
        "values": [6908.86,6878.88,6881.62,6816.63,6869.5,6830.71,6740.02,6795.99,6781.48,6775.8,6672.62,6632.19],
        "unit": "Points",
        "source": "FRED — St. Louis Fed",
        "timeRange": "Last 2 weeks",
        "chartLabel": "EQUITIES",
        "caption": "The S&P 500 declined over 4% in two weeks, reflecting broader risk-off positioning as rate expectations shifted higher.",
        "insertAfterParagraph": 2
      }
    ]
  }
}
ENDJSON
)

response=$(curl -s -w "\n%{http_code}" \
  -X POST \
  -H "Authorization: Bearer $SECRET" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  "$SITE_URL/api/news/correct")

http_code=$(echo "$response" | tail -n1)
body=$(echo "$response" | head -n -1)

echo "HTTP Status: $http_code"
echo "Response: $body"

if [ "$http_code" = "200" ]; then
  echo "✓ Article corrected successfully"
else
  echo "✗ Correction failed"
  exit 1
fi
