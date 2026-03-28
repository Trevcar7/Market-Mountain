import {
  Html,
  Head,
  Body,
  Container,
  Section,
  Text,
  Link,
  Hr,
  Heading,
  Preview,
} from "@react-email/components";

const SITE_URL = "https://marketmountainfinance.com";

const colors = {
  navy: "#0A1628",
  accent: "#22C55E",
  white: "#FFFFFF",
  gray: "#94A3B8",
  grayLight: "#F1F5F9",
  text: "#0F172A",
  textMuted: "#64748B",
};

const fonts = {
  heading: "Georgia, 'Times New Roman', serif",
  body: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
};

export default function WelcomeEmail() {
  return (
    <Html lang="en">
      <Head />
      <Preview>Welcome to Market Mountain — your daily markets briefing starts tomorrow</Preview>
      <Body
        style={{
          backgroundColor: colors.grayLight,
          fontFamily: fonts.body,
          margin: 0,
          padding: 0,
        }}
      >
        {/* Header */}
        <Section style={{ backgroundColor: colors.navy, padding: "32px 0" }}>
          <Container style={{ maxWidth: "600px", margin: "0 auto", padding: "0 20px" }}>
            <Text
              style={{
                color: colors.white,
                fontFamily: fonts.heading,
                fontSize: "24px",
                fontWeight: "bold",
                margin: "0 0 4px",
              }}
            >
              Market Mountain
            </Text>
            <Text style={{ color: colors.gray, fontSize: "13px", margin: 0 }}>
              Independent Equity Research
            </Text>
          </Container>
        </Section>

        <Container style={{ maxWidth: "600px", margin: "0 auto", padding: "0 20px" }}>
          <Section
            style={{
              backgroundColor: colors.white,
              borderRadius: "8px",
              padding: "32px 28px",
              marginTop: "24px",
            }}
          >
            <Heading
              as="h1"
              style={{
                color: colors.text,
                fontFamily: fonts.heading,
                fontSize: "22px",
                margin: "0 0 16px",
              }}
            >
              Welcome to Market Mountain
            </Heading>

            <Text
              style={{
                color: colors.text,
                fontSize: "15px",
                lineHeight: "1.7",
                margin: "0 0 16px",
              }}
            >
              You are now subscribed to the Daily Markets Briefing — a curated summary of the most important
              market-moving events, delivered to your inbox every trading day at 8:00 AM Eastern.
            </Text>

            <Text
              style={{
                color: colors.text,
                fontSize: "15px",
                lineHeight: "1.7",
                margin: "0 0 16px",
              }}
            >
              Each briefing includes:
            </Text>

            <Section style={{ paddingLeft: "8px" }}>
              {[
                "Lead story with market impact analysis",
                "Top developments across macro, earnings, and policy",
                "Key data: rates, commodities, and economic indicators",
                "What to watch: forward-looking signals for the trading day",
              ].map((item, i) => (
                <Text
                  key={i}
                  style={{
                    color: colors.text,
                    fontSize: "14px",
                    lineHeight: "1.6",
                    margin: "0 0 6px",
                    paddingLeft: "16px",
                  }}
                >
                  &#8226; {item}
                </Text>
              ))}
            </Section>

            <Text
              style={{
                color: colors.text,
                fontSize: "15px",
                lineHeight: "1.7",
                margin: "20px 0 24px",
              }}
            >
              In the meantime, explore the latest research and market analysis on the site.
            </Text>

            <Link
              href={`${SITE_URL}/briefing`}
              style={{
                backgroundColor: colors.accent,
                color: colors.navy,
                fontWeight: "bold",
                fontSize: "14px",
                padding: "12px 28px",
                borderRadius: "6px",
                textDecoration: "none",
                display: "inline-block",
              }}
            >
              Read Today&#39;s Briefing
            </Link>
          </Section>

          <Hr style={{ borderColor: "#E2E8F0", margin: "28px 0 20px" }} />

          <Section style={{ paddingBottom: "32px" }}>
            <Text
              style={{
                color: colors.gray,
                fontSize: "11px",
                lineHeight: "1.5",
                textAlign: "center" as const,
                margin: 0,
              }}
            >
              Market Mountain | Independent Equity Research
              <br />
              <Link
                href={`${SITE_URL}/preferences`}
                style={{ color: colors.gray }}
              >
                Manage preferences
              </Link>
              {" | "}
              <Link
                href={`${SITE_URL}/preferences?action=unsubscribe`}
                style={{ color: colors.gray }}
              >
                Unsubscribe
              </Link>
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}
