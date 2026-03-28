import {
  Html,
  Head,
  Body,
  Container,
  Section,
  Text,
  Link,
  Hr,
  Row,
  Column,
  Heading,
  Preview,
} from "@react-email/components";
import type { DailyBriefing } from "@/lib/news-types";

const SITE_URL = "https://marketmountainfinance.com";

// Summit theme colors
const colors = {
  navy: "#0A1628",
  navyLight: "#1A2744",
  accent: "#22C55E",
  accentDark: "#16A34A",
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

interface BriefingEmailProps {
  briefing: DailyBriefing;
  unsubscribeUrl?: string;
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00Z");
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export default function BriefingEmail({
  briefing,
  unsubscribeUrl = `${SITE_URL}/preferences`,
}: BriefingEmailProps) {
  const dateDisplay = formatDate(briefing.date);

  return (
    <Html lang="en">
      <Head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="light" />
      </Head>
      <Preview>
        {briefing.leadStory.title} — Market Mountain Daily Briefing
      </Preview>
      <Body
        style={{
          backgroundColor: colors.grayLight,
          fontFamily: fonts.body,
          margin: 0,
          padding: 0,
        }}
      >
        {/* Header */}
        <Section style={{ backgroundColor: colors.navy, padding: "24px 0" }}>
          <Container style={{ maxWidth: "600px", margin: "0 auto", padding: "0 20px" }}>
            <Text
              style={{
                color: colors.accent,
                fontSize: "11px",
                letterSpacing: "2px",
                textTransform: "uppercase" as const,
                margin: "0 0 4px",
              }}
            >
              DAILY MARKETS BRIEFING
            </Text>
            <Text
              style={{
                color: colors.white,
                fontFamily: fonts.heading,
                fontSize: "22px",
                fontWeight: "bold",
                margin: "0 0 4px",
              }}
            >
              Market Mountain
            </Text>
            <Text style={{ color: colors.gray, fontSize: "13px", margin: 0 }}>
              {dateDisplay}
            </Text>
          </Container>
        </Section>

        <Container style={{ maxWidth: "600px", margin: "0 auto", padding: "0 20px" }}>
          {/* Lead Story */}
          <Section
            style={{
              backgroundColor: colors.navy,
              borderRadius: "8px",
              padding: "24px",
              marginTop: "24px",
            }}
          >
            <Text
              style={{
                color: colors.accent,
                fontSize: "10px",
                letterSpacing: "1.5px",
                textTransform: "uppercase" as const,
                margin: "0 0 8px",
              }}
            >
              LEAD STORY
            </Text>
            <Link
              href={`${SITE_URL}/news/${briefing.leadStory.id}`}
              style={{ textDecoration: "none" }}
            >
              <Heading
                as="h2"
                style={{
                  color: colors.white,
                  fontFamily: fonts.heading,
                  fontSize: "20px",
                  lineHeight: "1.3",
                  margin: "0 0 12px",
                }}
              >
                {briefing.leadStory.title}
              </Heading>
            </Link>
            <Text
              style={{
                color: "rgba(255,255,255,0.7)",
                fontSize: "14px",
                lineHeight: "1.6",
                margin: "0 0 8px",
                borderLeft: `3px solid ${colors.accent}`,
                paddingLeft: "12px",
              }}
            >
              {briefing.leadStory.whyItMatters}
            </Text>
            <Text
              style={{
                color: "rgba(255,255,255,0.55)",
                fontSize: "14px",
                lineHeight: "1.6",
                margin: "12px 0 0",
              }}
            >
              {briefing.leadStory.summary}
            </Text>
            <Link
              href={`${SITE_URL}/news/${briefing.leadStory.id}`}
              style={{
                color: colors.accent,
                fontSize: "13px",
                fontWeight: "600",
                textDecoration: "none",
                display: "inline-block",
                marginTop: "12px",
              }}
            >
              Read full story &#8594;
            </Link>
          </Section>

          {/* Top Developments */}
          {briefing.topDevelopments.length > 0 && (
            <Section style={{ marginTop: "24px" }}>
              <Text
                style={{
                  color: colors.text,
                  fontSize: "11px",
                  letterSpacing: "1.5px",
                  textTransform: "uppercase" as const,
                  fontWeight: "bold",
                  margin: "0 0 12px",
                }}
              >
                TOP DEVELOPMENTS
              </Text>
              {briefing.topDevelopments.map((dev, i) => (
                <Section
                  key={i}
                  style={{
                    backgroundColor: colors.white,
                    borderRadius: "6px",
                    padding: "16px",
                    marginBottom: "8px",
                    borderLeft: `3px solid ${colors.accent}`,
                  }}
                >
                  <Link
                    href={`${SITE_URL}/news/${dev.id}`}
                    style={{ textDecoration: "none" }}
                  >
                    <Text
                      style={{
                        color: colors.text,
                        fontFamily: fonts.heading,
                        fontSize: "15px",
                        fontWeight: "600",
                        lineHeight: "1.3",
                        margin: "0 0 6px",
                      }}
                    >
                      {dev.headline}
                    </Text>
                  </Link>
                  <Text
                    style={{
                      color: colors.textMuted,
                      fontSize: "13px",
                      lineHeight: "1.5",
                      margin: 0,
                    }}
                  >
                    {dev.summary}
                  </Text>
                </Section>
              ))}
            </Section>
          )}

          {/* Key Data */}
          {briefing.keyData.length > 0 && (
            <Section style={{ marginTop: "24px" }}>
              <Text
                style={{
                  color: colors.text,
                  fontSize: "11px",
                  letterSpacing: "1.5px",
                  textTransform: "uppercase" as const,
                  fontWeight: "bold",
                  margin: "0 0 12px",
                }}
              >
                KEY DATA
              </Text>
              <Section
                style={{
                  backgroundColor: colors.navy,
                  borderRadius: "8px",
                  padding: "16px",
                }}
              >
                <Row>
                  {briefing.keyData.slice(0, 6).map((dp, i) => (
                    <Column
                      key={i}
                      style={{
                        width: "33.33%",
                        padding: "8px",
                        textAlign: "center" as const,
                      }}
                    >
                      <Text
                        style={{
                          color: colors.gray,
                          fontSize: "9px",
                          letterSpacing: "1px",
                          textTransform: "uppercase" as const,
                          margin: "0 0 4px",
                        }}
                      >
                        {dp.label}
                      </Text>
                      <Text
                        style={{
                          color: colors.white,
                          fontSize: "16px",
                          fontWeight: "bold",
                          margin: 0,
                        }}
                      >
                        {dp.value}
                      </Text>
                    </Column>
                  ))}
                </Row>
              </Section>
            </Section>
          )}

          {/* What to Watch */}
          {briefing.whatToWatch.length > 0 && (
            <Section style={{ marginTop: "24px" }}>
              <Text
                style={{
                  color: colors.text,
                  fontSize: "11px",
                  letterSpacing: "1.5px",
                  textTransform: "uppercase" as const,
                  fontWeight: "bold",
                  margin: "0 0 12px",
                }}
              >
                WHAT TO WATCH
              </Text>
              {briefing.whatToWatch.map((item, i) => (
                <Section
                  key={i}
                  style={{
                    backgroundColor: colors.white,
                    borderRadius: "6px",
                    padding: "14px 16px",
                    marginBottom: "8px",
                  }}
                >
                  <Text
                    style={{
                      color: colors.text,
                      fontSize: "14px",
                      fontWeight: "600",
                      margin: "0 0 4px",
                    }}
                  >
                    {i + 1}. {item.event}
                  </Text>
                  <Text
                    style={{
                      color: colors.textMuted,
                      fontSize: "12px",
                      lineHeight: "1.5",
                      margin: "0 0 4px",
                    }}
                  >
                    {item.significance}
                  </Text>
                  {item.watchMetric && (
                    <Text
                      style={{
                        color: colors.accentDark,
                        fontSize: "12px",
                        fontWeight: "500",
                        margin: 0,
                      }}
                    >
                      Watch: {item.watchMetric}
                    </Text>
                  )}
                </Section>
              ))}
            </Section>
          )}

          {/* CTA */}
          <Section style={{ textAlign: "center" as const, marginTop: "28px" }}>
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
              View Full Briefing on Site
            </Link>
          </Section>

          <Hr style={{ borderColor: "#E2E8F0", margin: "28px 0 20px" }} />

          {/* Footer */}
          <Section style={{ paddingBottom: "32px" }}>
            <Text
              style={{
                color: colors.textMuted,
                fontSize: "12px",
                lineHeight: "1.5",
                textAlign: "center" as const,
                margin: "0 0 8px",
              }}
            >
              Market Mountain | Independent Equity Research
            </Text>
            <Text
              style={{
                color: colors.gray,
                fontSize: "11px",
                lineHeight: "1.5",
                textAlign: "center" as const,
                margin: "0 0 8px",
              }}
            >
              This email is for informational purposes only and does not
              constitute financial advice.
            </Text>
            <Text style={{ textAlign: "center" as const, margin: 0 }}>
              <Link
                href={unsubscribeUrl}
                style={{ color: colors.gray, fontSize: "11px" }}
              >
                Manage preferences
              </Link>
              {" | "}
              <Link
                href={`${unsubscribeUrl}?action=unsubscribe`}
                style={{ color: colors.gray, fontSize: "11px" }}
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
