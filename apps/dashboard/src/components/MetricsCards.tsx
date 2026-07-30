"use client";

import React from "react";

interface StatsProps {
  stats: {
    totalSimulations: number;
    totalGameFits: number;
    totalPublicWebRuns: number;
    elapsedHours: string;
    remainingHours: string;
    latestPyTorchLoss: number | null;
    latestPyTorchAccuracy: number | null;
    latestSimDelta: number | null;
  };
  iteration: number;
}

export const MetricsCards: React.FC<StatsProps> = ({ stats, iteration }) => {
  const cards = [
    {
      title: "PyTorch Action Accuracy",
      value: stats.latestPyTorchAccuracy
        ? `${(stats.latestPyTorchAccuracy * 100).toFixed(1)}%`
        : "N/A",
      subtext: "Multi-head neural policy validation",
      color: "var(--accent-emerald)",
      icon: "&#127919;",
    },
    {
      title: "Behavior Cloning Loss",
      value: stats.latestPyTorchLoss
        ? stats.latestPyTorchLoss.toFixed(4)
        : "N/A",
      subtext: "3D Shooter neural network loss",
      color: "var(--accent-cyan)",
      icon: "&#128201;",
    },
    {
      title: "Resilience Advantage Delta",
      value: stats.latestSimDelta ? `+${(stats.latestSimDelta * 100).toFixed(0)}%` : "N/A",
      subtext: "Semantic vs static selector ablation",
      color: "var(--accent-purple)",
      icon: "&#128737;",
    },
    {
      title: "Total Completed Cycles",
      value: `${iteration} / Loop`,
      subtext: `${stats.totalGameFits} Fits | ${stats.totalPublicWebRuns} Skills | ${(stats as { totalSlowPathPlans?: number }).totalSlowPathPlans ?? 0} SlowPath`,
      color: "var(--accent-amber)",
      icon: "&#9889;",
    },
    {
      title: "Rolling Success Rate",
      value:
        (stats as { rollingSuccessRate?: number | null }).rollingSuccessRate != null
          ? `${(((stats as { rollingSuccessRate?: number }).rollingSuccessRate ?? 0) * 100).toFixed(1)}%`
          : "N/A",
      subtext: "Last 100 training outcomes",
      color: "var(--accent-emerald)",
      icon: "&#128200;",
    },
  ];

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
        gap: "20px",
        marginBottom: "28px",
      }}
    >
      {cards.map((card, idx) => (
        <div
          key={idx}
          className="glass-panel"
          style={{ padding: "24px", position: "relative", overflow: "hidden" }}
        >
          <div
            style={{
              position: "absolute",
              top: "-15px",
              right: "-15px",
              fontSize: "48px",
              opacity: 0.15,
            }}
            dangerouslySetInnerHTML={{ __html: card.icon }}
          />
          <p
            style={{
              fontSize: "13px",
              fontWeight: 600,
              color: "var(--text-secondary)",
              marginBottom: "8px",
            }}
          >
            {card.title}
          </p>
          <div
            style={{
              fontSize: "28px",
              fontWeight: 800,
              color: card.color,
              marginBottom: "6px",
              letterSpacing: "-0.5px",
            }}
          >
            {card.value}
          </div>
          <p style={{ fontSize: "12px", color: "var(--text-muted)" }}>
            {card.subtext}
          </p>
        </div>
      ))}
    </div>
  );
};
