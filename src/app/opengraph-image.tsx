import { ImageResponse } from "next/og";

export const runtime = "edge";
export const alt = "Market Mountain — Independent Equity Research";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/**
 * Dynamically generated Open Graph image for Market Mountain.
 * Rendered at build time (or on-demand) by Next.js ImageResponse.
 * Shows on link previews in iMessage, Slack, Twitter/X, LinkedIn, etc.
 */
export default function OgImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          background: "#0A1628",
          fontFamily: "Georgia, serif",
          padding: "60px",
        }}
      >
        {/* Mountain SVG logo */}
        <svg
          width="100"
          height="80"
          viewBox="0 0 100 80"
          fill="none"
          style={{ marginBottom: "28px" }}
        >
          {/* Main mountain silhouette */}
          <path
            d="M0 80 L28 25 L42 42 L60 8 L100 80 Z"
            fill="#FFFFFF"
          />
          {/* Green summit accent triangle */}
          <polygon
            points="60,0 68,14 52,14"
            fill="#22C55E"
          />
          {/* Snow/highlight on right peak */}
          <path
            d="M60 8 L68 22 L52 22 Z"
            fill="rgba(255,255,255,0.22)"
          />
        </svg>

        {/* Site name */}
        <div
          style={{
            fontSize: 72,
            fontWeight: 700,
            color: "#FFFFFF",
            letterSpacing: "-1px",
            lineHeight: 1,
            marginBottom: "16px",
            textAlign: "center",
          }}
        >
          Market Mountain
        </div>

        {/* Accent divider */}
        <div
          style={{
            width: "80px",
            height: "3px",
            background: "#22C55E",
            marginBottom: "20px",
            borderRadius: "2px",
          }}
        />

        {/* Tagline */}
        <div
          style={{
            fontSize: 28,
            color: "rgba(255,255,255,0.60)",
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            textAlign: "center",
          }}
        >
          Independent Equity Research
        </div>

        {/* Domain */}
        <div
          style={{
            position: "absolute",
            bottom: "40px",
            right: "60px",
            fontSize: "18px",
            color: "rgba(255,255,255,0.35)",
            letterSpacing: "0.05em",
          }}
        >
          marketmountainfinance.com
        </div>
      </div>
    ),
    size
  );
}
