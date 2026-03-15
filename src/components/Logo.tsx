import Link from "next/link";

interface LogoProps {
  variant?: "light" | "dark";
  size?: "sm" | "md" | "lg" | "xl";
  showText?: boolean;
}

export default function Logo({
  variant = "dark",
  size = "md",
  showText = true,
}: LogoProps) {
  const sizes = {
    sm: { icon: 28, text: "text-lg" },
    md: { icon: 36, text: "text-xl" },
    lg: { icon: 52, text: "text-3xl" },
    xl: { icon: 80, text: "text-5xl" },
  };

  const { icon, text } = sizes[size];
  const mountainColor = variant === "light" ? "#FFFFFF" : "#0A1628";
  const green = "#22C55E";

  return (
    <Link href="/" className="flex items-center gap-2.5 group select-none">
      <svg
        width={icon}
        height={icon}
        viewBox="0 0 52 52"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="shrink-0"
        aria-hidden="true"
      >
        {/* Mountain body — M-shaped silhouette: left peak shorter, right peak taller */}
        <path
          d="M4 48 L17 18 L26 28 L36 9 L48 48 Z"
          fill={mountainColor}
        />

        {/* Snow highlight on right (main) peak — dark variant only */}
        {variant === "dark" && (
          <path
            d="M26 28 L36 9 L31 21 Z"
            fill="rgba(255,255,255,0.48)"
          />
        )}

        {/* Green summit marker — solid upward triangle above the main peak */}
        <polygon points="36,1 29,11 43,11" fill={green} />
      </svg>

      {showText && (
        <span
          className={`${text} font-bold leading-none font-playfair`}
          style={{
            color: mountainColor,
            letterSpacing: "-0.03em",
          }}
        >
          Market{" "}
          <span style={{ color: green }}>Mountain</span>
        </span>
      )}
    </Link>
  );
}
