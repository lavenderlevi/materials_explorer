import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import AppLayout from "./AppLayout";
import SemanticSearch from "./tabs/SemanticSearch";
import Recommendations from "./tabs/Recommendations";
import SimilarMaterials from "./tabs/SimilarMaterials";
import MLPredictions from "./tabs/MLPredictions";
import CrystalSimilarity from "./tabs/CrystalSimilarity";
import PropertyCorrelation from "./tabs/PropertyCorrelation";
import Workspace from "./tabs/Workspace";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<AppLayout />}>
          <Route index element={<Navigate to="/semantic-search" replace />} />
          <Route path="semantic-search"      element={<SemanticSearch />} />
          <Route path="recommendations"      element={<Recommendations />} />
          <Route path="similar-materials"    element={<SimilarMaterials />} />
          <Route path="ml-predictions"       element={<MLPredictions />} />
          <Route path="crystal-similarity"   element={<CrystalSimilarity />} />
          <Route path="property-correlation" element={<PropertyCorrelation />} />
          <Route path="workspace"            element={<Workspace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </React.StrictMode>
);
