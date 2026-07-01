"""
Materials Explorer — Streamlit launcher.

This file is the original Streamlit entrypoint, preserved for compatibility.
It now redirects users to the React SPA served by FastAPI.

To run the full stack:
    # Terminal 1 — FastAPI backend + React frontend
    uvicorn api.main:app --reload --port 8000

    # Terminal 2 (development only) — Vite dev server with HMR
    cd frontend && npm run dev

    # Or build once for production:
    cd frontend && npm run build
    uvicorn api.main:app --port 8000

If you still want the original Streamlit UI:
    streamlit run app_streamlit_legacy.py
"""
import streamlit as st

st.set_page_config(
    page_title="Materials Explorer",
    page_icon="⚗️",
    layout="centered",
    initial_sidebar_state="collapsed",
)

REACT_PORT = 8000

st.markdown("""
<style>
    body { background: #09090B; }
    .block-container { max-width: 600px; margin: 80px auto; padding: 40px; background: #0F172A; border-radius: 12px; border: 1px solid rgba(148,163,184,0.12); }
    h1 { color: #F1F5F9; font-family: 'Inter', sans-serif; }
    p  { color: #94A3B8; font-family: 'Inter', sans-serif; }
</style>
""", unsafe_allow_html=True)

st.markdown("## ⚗️ Materials Explorer")
st.markdown(
    "The UI has been upgraded to a **React + FastAPI** stack for a richer experience. "
    "The Streamlit interface is no longer the primary frontend."
)

st.info(
    "**To launch the new interface:** \n\n"
    "```bash\n"
    "# Build the React app (once)\n"
    "cd frontend && npm install && npm run build\n\n"
    "# Start the server\n"
    "uvicorn api.main:app --reload --port 8000\n"
    "```\n\n"
    f"Then open **http://localhost:{REACT_PORT}** in your browser."
)

st.markdown("---")
st.markdown("### Development mode (HMR)")
st.code(
    "# Terminal 1\nuvicorn api.main:app --reload --port 8000\n\n"
    "# Terminal 2\ncd frontend && npm run dev\n"
    "# → http://localhost:5173",
    language="bash",
)

st.markdown("---")
col1, col2 = st.columns(2)
with col1:
    st.markdown(f"[**Open React UI →**](http://localhost:{REACT_PORT})")
with col2:
    st.markdown(f"[**API Docs →**](http://localhost:{REACT_PORT}/api/docs)")
