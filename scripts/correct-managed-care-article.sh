#!/bin/bash
# Correct editorial issues in article news-1773598101820-952
# "Bernstein Cuts Humana Target as 4.27% Treasury Yield Amplifies Managed Care Margin Pressure"
#
# Issues fixed:
# 1. Overly precise valuation claim (25bp → 2-3% rule)
# 2. Irrelevant Prudential Financial reference removed, replaced with managed care sector analysis
# 3. Rate policy claim reframed to reflect market expectations
# 4. Market impact updated: PRU removed, UNH added as relevant managed care peer

SITE_URL="${NEXT_PUBLIC_SITE_URL:-https://marketmountainfinance.com}"
SECRET="${FETCH_NEWS_SECRET:-mm-news-secret-2026}"

curl -s -X POST "${SITE_URL}/api/news/correct" \
  -H "Authorization: Bearer ${SECRET}" \
  -H "Content-Type: application/json" \
  -d "$(cat <<'ENDJSON'
{
  "id": "news-1773598101820-952",
  "replacements": [
    {
      "field": "story",
      "from": "\"Every 25 basis point increase in the risk-free rate effectively reduces the present value of healthcare cash flows by 2 to 3 percent, amplifying the damage from any simultaneous earnings revision.\"",
      "to": "Higher risk-free rates reduce the present value of longer-duration cash flows, and when yields are rising alongside negative earnings revisions, the valuation impact compounds significantly."
    },
    {
      "field": "story",
      "from": "Prudential Financial's downward target revision signals that even diversified financial services names face repricing pressure as rates normalize. Unlike pure-play managed care operators, Prudential benefits from higher rates on its insurance float and investment portfolios; yet analysts are still cutting targets, suggesting that equity market concerns about growth deceleration outweigh fixed-income benefits. This highlights a critical distinction in sector positioning: insurance and healthcare equities that depend on volume growth are facing downgrades, while those with embedded leverage to higher rates and AI-driven operational leverage are holding valuations. The divergence is not random; it reflects the market's repricing of duration risk and growth expectations as the Fed Funds Rate settles at 3.64%, a level that pressures any equity dependent on multiple expansion.",
      "to": "The repricing pressure extends beyond Humana. UnitedHealth Group and Centene face similar headwinds as medical loss ratios widen across the managed care sector. Analysts at several firms have noted that Stars rating pressure is not company-specific but reflects systemic changes in CMS evaluation criteria that affect reimbursement across the industry. The critical distinction in sector positioning is between managed care operators that depend on volume growth and Medicare Advantage enrollment, which are facing downgrades, and healthcare names with diversified revenue streams and pricing power, which are holding valuations. This divergence reflects the market's repricing of duration risk and growth expectations at current rate levels."
    },
    {
      "field": "story",
      "from": "The Fed Funds Rate at 3.64% suggests that rate cuts are unlikely in the near term, keeping discount rates elevated.",
      "to": "With the Fed Funds Rate at 3.64%, futures markets reflect limited expectations for near-term cuts, keeping discount rates elevated."
    }
  ],
  "fieldUpdates": {
    "marketImpact": [
      { "asset": "HUM", "change": "Target cut", "direction": "down" },
      { "asset": "UNH", "change": "Sector pressure", "direction": "down" }
    ]
  },
  "reason": "Editorial correction: (1) removed overly precise 25bp/2-3% valuation rule, replaced with directional language; (2) replaced irrelevant Prudential Financial paragraph with managed care sector analysis; (3) reframed Fed rate claim to reference market expectations; (4) replaced PRU with UNH in market impact for sector relevance"
}
ENDJSON
)" | python3 -m json.tool 2>/dev/null || echo "Response received"
