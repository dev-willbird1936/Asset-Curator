import React from "react";
import { AbsoluteFill, Composition, interpolate, registerRoot, useCurrentFrame } from "remotion";
const MotionCard = () => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 18, 100, 120], [0, 1, 1, 0], {extrapolateLeft: "clamp", extrapolateRight: "clamp"});
  const y = interpolate(frame, [0, 25], [50, 0], {extrapolateRight: "clamp"});
  return <AbsoluteFill style={{background: "#102b30", justifyContent: "center", padding: 100, fontFamily: "Arial", color: "#f1f6df"}}>
    <div style={{width: 96, height: 10, background: "#adf58b", marginBottom: 36, opacity}} />
    <div style={{fontSize: 90, fontWeight: 800, letterSpacing: -4, opacity, transform: `translateY(${y}px)`}}>Make something useful.</div>
    <div style={{fontSize: 32, marginTop: 30, color: "#acbebb", opacity}}>Editable code. Original motion. No external media.</div>
  </AbsoluteFill>;
};
const Root = () => <Composition id="AssetClip" component={MotionCard} width={1280} height={720} fps={30} durationInFrames={120} />;
registerRoot(Root);
