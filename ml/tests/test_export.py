import pytest

from blockdream_wm.export_onnx import export

onnx = pytest.importorskip("onnx")


def test_export_emits_two_valid_onnx_models(tmp_path):
    written = export(config=None, out_dir=str(tmp_path))
    names = sorted(p.name for p in written)
    assert names == ["decoder.onnx", "transition.onnx"]
    for p in written:
        assert p.exists() and p.stat().st_size > 0
        model = onnx.load(str(p))
        onnx.checker.check_model(model)  # raises if malformed


def test_transition_onnx_io_names(tmp_path):
    written = export(config=None, out_dir=str(tmp_path))
    trans = next(p for p in written if p.name == "transition.onnx")
    model = onnx.load(str(trans))
    inputs = {i.name for i in model.graph.input}
    assert {"z_t", "t", "prev", "action"} <= inputs
    assert any(o.name == "velocity" for o in model.graph.output)
