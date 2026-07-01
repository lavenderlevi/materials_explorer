"""
Page 7 — Experiment Workspace

Three tabs:
  💾 Saved Searches  — run, save, re-run and delete searches.
  🔬 Comparison Sets — build named material sets, view side-by-side
                       property comparison tables, add/remove materials.
  📤 Dataset Export  — export a corpus (comparison set or custom fetch)
                       to CSV, JSON, or Excel with selectable columns.
"""

from __future__ import annotations

from datetime import datetime

import pandas as pd
import streamlit as st

from resources import (
    get_api_key,
    get_mp_client,
    get_search_engine,
    get_workspace_manager,
    render_api_key_sidebar,
)
from search.models import SUMMARY_FIELDS
from search.parser import IntentParser
from search.workspace import ComparisonSet

st.set_page_config(
    page_title="Workspace · Materials Explorer",
    page_icon="🗂️",
    layout="wide",
)
st.title("🗂️ Experiment Workspace")
st.markdown(
    "Save searches, build comparison sets, and export datasets "
    "for further analysis."
)

render_api_key_sidebar()
api_key = get_api_key()
wm = get_workspace_manager()
stats = wm.store.workspace_stats()

# ---------------------------------------------------------------------------
# Sidebar — workspace stats
# ---------------------------------------------------------------------------
with st.sidebar:
    st.divider()
    st.subheader("📦 Workspace Stats")
    c1, c2 = st.columns(2)
    c1.metric("Saved Searches", stats["saved_searches"])
    c2.metric("Comparison Sets", stats["comparison_sets"])
    c1.metric("Materials Tracked", stats["comparison_items"])
    c2.metric("Exports", stats["exports"])


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _ts(ts: float) -> str:
    return datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M")


def _comparison_df(cset: ComparisonSet) -> pd.DataFrame:
    """Build a transposed comparison table: property rows × material columns."""
    _PROPS: dict[str, str] = {
        "Band Gap (eV)": "band_gap",
        "Density (g/cm³)": "density",
        "Formation E (eV/at)": "formation_energy_per_atom",
        "E Hull (eV/at)": "energy_above_hull",
        "Crystal System": "crystal_system",
        "Spacegroup": "spacegroup_symbol",
        "N Sites": "nsites",
        "N Elements": "nelements",
        "Stable": "is_stable",
        "Magnetic": "is_magnetic",
    }
    data: dict[str, dict] = {}
    for item in cset.items:
        doc = item.document
        col = f"{doc.material_id}\n{doc.formula_pretty}"
        data[col] = {}
        for label, field in _PROPS.items():
            val = getattr(doc, field, None)
            if field in ("is_stable", "is_magnetic"):
                data[col][label] = "✅" if val else "⚠️"
            elif val is None:
                data[col][label] = "N/A"
            elif isinstance(val, float):
                data[col][label] = round(val, 4)
            else:
                data[col][label] = val
    return pd.DataFrame(data)


def _render_mini_table(docs: list) -> None:
    """Compact result table for inline search re-run display."""
    rows = [
        {
            "ID": d.material_id, "Formula": d.formula_pretty,
            "Band Gap": d.band_gap, "Density": d.density,
            "Stable": "✅" if d.is_stable else "⚠️",
        }
        for d in docs[:10]
    ]
    st.dataframe(pd.DataFrame(rows), use_container_width=True, hide_index=True)


# ---------------------------------------------------------------------------
# Tabs
# ---------------------------------------------------------------------------
tab_saved, tab_compare, tab_export = st.tabs(
    ["💾 Saved Searches", "🔬 Comparison Sets", "📤 Dataset Export"]
)

# ===========================================================================
# Tab 1 — Saved Searches
# ===========================================================================
with tab_saved:
    # --- Save new search ---
    with st.expander("➕ Save a New Search", expanded=stats["saved_searches"] == 0):
        col_q, col_n = st.columns([3, 2])
        new_query = col_q.text_input(
            "Query", placeholder="e.g. stable semiconductor band gap > 1",
            key="ws_new_query",
        )
        save_name = col_n.text_input(
            "Save as (optional name)", placeholder="My Search", key="ws_save_name"
        )
        if st.button("🔍 Search & Save", type="primary", key="ws_search_save"):
            if not api_key:
                st.error("API key required to run searches.")
            elif not new_query.strip():
                st.warning("Enter a query first.")
            else:
                parser = IntentParser()
                engine = get_search_engine(api_key)
                with st.spinner("Running search…"):
                    pq = parser.parse(new_query.strip())
                    resp = engine.search(pq)
                if resp.results:
                    ids = [r.material.material_id for r in resp.results]
                    name = save_name.strip() or new_query.strip()[:50]
                    wm.store.save_search(
                        name=name, raw_query=new_query.strip(),
                        parsed_query=pq, result_ids=ids,
                    )
                    st.success(f"✅ Saved **{name}** — {len(ids)} results.")
                    st.rerun()
                else:
                    st.warning("No results returned — search not saved.")

    st.divider()

    # --- List saved searches ---
    searches = wm.store.get_saved_searches()
    if not searches:
        st.info("No saved searches yet. Use the form above to save your first search.")

    for s in searches:
        last = _ts(s.last_run_at) if s.last_run_at else "never"
        with st.expander(
            f"**{s.name}**  |  `{s.raw_query}`  —  "
            f"{s.result_count} results  ·  saved {_ts(s.created_at)}",
            expanded=False,
        ):
            st.caption(
                f"Intent: `{s.parsed_query.intent.value}` · "
                f"Confidence: {s.parsed_query.confidence:.0%} · Last run: {last}"
            )
            col_r, col_d = st.columns([4, 1])
            if col_r.button("🔄 Re-run", key=f"rerun_{s.id}"):
                if not api_key:
                    st.error("API key required.")
                else:
                    with st.spinner("Re-running…"):
                        resp = get_search_engine(api_key).search(s.parsed_query)
                    wm.store.update_last_run(s.id)
                    if resp.results:
                        _render_mini_table([r.material for r in resp.results])
                    else:
                        st.warning("No results returned.")
            if col_d.button("🗑️ Delete", key=f"del_s_{s.id}"):
                wm.store.delete_saved_search(s.id)
                st.rerun()

# ===========================================================================
# Tab 2 — Comparison Sets
# ===========================================================================
with tab_compare:
    # --- Create new set ---
    with st.expander("➕ Create New Comparison Set", expanded=stats["comparison_sets"] == 0):
        col_nm, col_nt = st.columns([2, 3])
        set_name = col_nm.text_input("Set Name", placeholder="e.g. Battery Cathodes", key="cs_name")
        set_notes = col_nt.text_input("Notes (optional)", placeholder="Context or goal", key="cs_notes")
        if st.button("Create Set", key="cs_create"):
            if not set_name.strip():
                st.warning("Enter a set name.")
            else:
                wm.store.create_comparison_set(set_name.strip(), set_notes.strip())
                st.success(f"✅ Created **{set_name.strip()}**.")
                st.rerun()

    st.divider()

    # --- List comparison sets ---
    csets = wm.store.get_comparison_sets()
    if not csets:
        st.info("No comparison sets yet. Create one above, then add materials to it.")

    for cset in csets:
        with st.expander(
            f"**{cset.name}**  —  {len(cset.items)} material(s)"
            + (f"  |  {cset.notes}" if cset.notes else ""),
            expanded=False,
        ):
            # Comparison table
            if cset.items:
                cdf = _comparison_df(cset)
                st.dataframe(cdf, use_container_width=True)
            else:
                st.caption("No materials in this set yet.")

            # Add material
            col_add, col_addbtn = st.columns([4, 1])
            add_id = col_add.text_input(
                "Add by Material ID", placeholder="e.g. mp-149", key=f"add_{cset.id}"
            )
            if col_addbtn.button("➕ Add", key=f"addbtn_{cset.id}"):
                if not api_key:
                    st.error("API key required to fetch material data.")
                elif not add_id.strip():
                    st.warning("Enter a material ID.")
                else:
                    with st.spinner(f"Fetching `{add_id.strip()}`…"):
                        doc = get_mp_client(api_key).get_by_id(
                            add_id.strip().lower(), fields=SUMMARY_FIELDS
                        )
                    if doc is None:
                        st.error(f"`{add_id.strip()}` not found.")
                    elif wm.store.add_to_set(cset.id, doc):
                        st.success(f"Added `{doc.material_id}` → **{cset.name}**.")
                        st.rerun()
                    else:
                        st.info(f"`{doc.material_id}` is already in this set.")

            # Remove materials
            if cset.items:
                st.markdown("**Remove:**")
                rem_cols = st.columns(min(len(cset.items), 4))
                for idx, item in enumerate(cset.items):
                    if rem_cols[idx % 4].button(
                        f"✖ {item.material_id}", key=f"rem_{cset.id}_{item.material_id}"
                    ):
                        wm.store.remove_from_set(cset.id, item.material_id)
                        st.rerun()

            # Delete set
            st.divider()
            if st.button("🗑️ Delete This Set", key=f"del_cs_{cset.id}"):
                wm.store.delete_comparison_set(cset.id)
                st.rerun()

# ===========================================================================
# Tab 3 — Dataset Export
# ===========================================================================
with tab_export:
    st.markdown("Export a material corpus to **CSV**, **JSON**, or **Excel**.")
    st.divider()

    # --- Source selection ---
    source = st.radio(
        "Export Source",
        options=["comparison_set", "custom_fetch"],
        format_func=lambda s: (
            "🔬 From a Comparison Set" if s == "comparison_set"
            else "🌐 Custom Fetch (by element filter)"
        ),
        horizontal=True,
    )

    export_docs: list = []
    source_label: str = ""

    if source == "comparison_set":
        csets = wm.store.get_comparison_sets()
        if not csets:
            st.warning("No comparison sets yet. Create one in the **Comparison Sets** tab.")
            st.stop()
        set_opts = {cs.name: cs for cs in csets}
        chosen_name = st.selectbox("Select Comparison Set", options=list(set_opts.keys()))
        chosen_set = set_opts[chosen_name]
        export_docs = [item.document for item in chosen_set.items]
        source_label = f"comparison set: {chosen_name}"
        st.caption(f"**{len(export_docs)}** materials in **{chosen_name}**.")

    else:  # custom_fetch
        if not api_key:
            st.error("API key required for custom fetch.")
            st.stop()
        col_el, col_sz = st.columns([3, 1])
        el_input = col_el.text_input(
            "Required elements (comma-separated)",
            placeholder="e.g.  Li, Fe, O",
            key="exp_elements",
        )
        exp_size = col_sz.slider("Max materials", 20, 500, 100, step=20, key="exp_size")
        exp_stable = st.checkbox("Stable only (eah ≤ 0)", value=False, key="exp_stable")
        fetch_btn = st.button("📥 Fetch Corpus", key="exp_fetch")

        if fetch_btn:
            if not el_input.strip():
                st.error("Specify at least one element.")
            else:
                fetch_filters: dict = {
                    "elements": [e.strip() for e in el_input.split(",") if e.strip()]
                }
                if exp_stable:
                    fetch_filters["energy_above_hull"] = (None, 0.0)
                with st.spinner("Fetching corpus…"):
                    try:
                        fetched = get_mp_client(api_key).search(
                            fields=SUMMARY_FIELDS, **fetch_filters
                        )
                        export_docs = fetched[:exp_size]
                        st.session_state["_export_docs"] = export_docs
                        source_label = f"elements: {el_input.strip()}"
                    except Exception as exc:
                        st.error(f"Fetch error: {exc}")
        else:
            export_docs = st.session_state.get("_export_docs", [])
            source_label = "custom fetch"

        if export_docs:
            st.caption(f"**{len(export_docs)}** materials ready for export.")

    # --- Column selection ---
    if export_docs:
        st.divider()
        st.subheader("⚙️ Export Options")

        col_labels = {
            "material_id": "Material ID", "formula_pretty": "Formula",
            "band_gap": "Band Gap", "density": "Density",
            "formation_energy_per_atom": "Formation Energy",
            "energy_above_hull": "E above Hull", "volume": "Volume",
            "nsites": "N Sites", "nelements": "N Elements",
            "crystal_system": "Crystal System", "spacegroup_symbol": "Spacegroup",
            "chemsys": "Chem System", "elements": "Elements",
            "is_stable": "Stable", "is_magnetic": "Magnetic",
            "has_dos": "Has DOS", "has_band_structure": "Has Band Structure",
            "has_elastic": "Has Elastic", "theoretical": "Theoretical",
            "mp_url": "MP URL",
        }
        selected_cols = st.multiselect(
            "Columns to include",
            options=list(col_labels.keys()),
            default=["material_id", "formula_pretty", "band_gap", "density",
                     "formation_energy_per_atom", "energy_above_hull",
                     "is_stable", "crystal_system"],
            format_func=lambda k: col_labels.get(k, k),
            key="exp_cols",
        )
        fmt = st.radio(
            "Export Format",
            options=["csv", "json", "excel"],
            format_func=lambda f: {"csv": "📄 CSV", "json": "🗒️ JSON", "excel": "📊 Excel"}[f],
            horizontal=True,
            key="exp_fmt",
        )

        # Preview
        preview_df = wm.exporter.to_dataframe(export_docs[:5], selected_cols or None)
        st.caption(f"Preview (first 5 of {len(export_docs)} materials):")
        st.dataframe(preview_df, use_container_width=True, hide_index=True)

        # Download
        ext_map = {"csv": "csv", "json": "json", "excel": "xlsx"}
        mime_map = {
            "csv": "text/csv",
            "json": "application/json",
            "excel": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        }
        try:
            data = wm.export(
                docs=export_docs,
                fmt=fmt,
                columns=selected_cols or None,
                query_text=source_label,
            )
            st.download_button(
                label=f"⬇️ Download {fmt.upper()} ({len(export_docs)} materials)",
                data=data,
                file_name=f"materials_export.{ext_map[fmt]}",
                mime=mime_map[fmt],
                type="primary",
            )
        except ImportError:
            st.error("Excel export requires `openpyxl`. Run: `pip install openpyxl`")
        except Exception as exc:
            st.error(f"Export error: {exc}")