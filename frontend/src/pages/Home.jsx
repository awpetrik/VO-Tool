import { useEffect } from "react";
import Hero from "../components/Hero";
import FeatureCards from "../components/FeatureCards";

function Home() {
  useEffect(() => {
    document.body.classList.add("home-no-scroll");
    return () => {
      document.body.classList.remove("home-no-scroll");
    };
  }, []);

  return (
    <div className="home-shell">
      <Hero />
      <FeatureCards />
    </div>
  );
}

export default Home;
