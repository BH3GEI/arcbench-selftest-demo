import pytest

from app.packhash import count_tests, pack_hash


def test_pack_hash_is_deterministic(tmp_path):
    (tmp_path / "a.spec.ts").write_text("test('a', () => {});")
    (tmp_path / "support").mkdir()
    (tmp_path / "support" / "e2e.ts").write_text("export const x = 1;")
    assert pack_hash(tmp_path) == pack_hash(tmp_path)


def test_pack_hash_changes_with_content(tmp_path):
    (tmp_path / "a.spec.ts").write_text("v1")
    first = pack_hash(tmp_path)
    (tmp_path / "a.spec.ts").write_text("v2")
    assert pack_hash(tmp_path) != first


def test_pack_hash_changes_with_filename(tmp_path):
    (tmp_path / "a.spec.ts").write_text("same")
    first = pack_hash(tmp_path)
    (tmp_path / "a.spec.ts").rename(tmp_path / "b.spec.ts")
    assert pack_hash(tmp_path) != first


def test_missing_pack_dir_raises(tmp_path):
    with pytest.raises(FileNotFoundError):
        pack_hash(tmp_path / "nope")


def test_count_tests(tmp_path):
    (tmp_path / "a.spec.ts").write_text("test('a');\ntest('b');")
    (tmp_path / "helper.ts").write_text("export const f = () => test;")
    assert count_tests(tmp_path) == 3
