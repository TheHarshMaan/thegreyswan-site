# Copyright (c) 2010-2024 openpyxl
# The sandbox image build puts this file in place of openpyxl's own compat/numbers.py, which imports numpy.
# A numpy number cannot reach openpyxl before something has imported numpy, so numpy's types are looked up only then.

import sys
from decimal import Decimal
from importlib.util import find_spec

NUMERIC_TYPES = (int, float, Decimal)


if "numpy" in sys.modules:
    NUMPY = sys.modules["numpy"] is not None
else:
    try:
        NUMPY = find_spec("numpy") is not None
    except (ImportError, ValueError):
        NUMPY = False


def _numpy_types():
    """numpy's number types, or () while numpy is not imported."""
    numpy = sys.modules.get("numpy")
    if numpy is None:
        return ()
    try:
        types = (
            numpy.short,
            numpy.ushort,
            numpy.intc,
            numpy.uintc,
            numpy.int_,
            numpy.uint,
            numpy.longlong,
            numpy.ulonglong,
            numpy.half,
            numpy.float16,
            numpy.single,
            numpy.double,
            numpy.longdouble,
            numpy.int8,
            numpy.int16,
            numpy.int32,
            numpy.int64,
            numpy.uint8,
            numpy.uint16,
            numpy.uint32,
            numpy.uint64,
            numpy.intp,
            numpy.uintp,
            numpy.float32,
            numpy.float64,
            numpy.bool_,
            numpy.floating,
            numpy.integer,
        )
    except AttributeError:
        return ()  # numpy is part-way through being imported
    if not all(isinstance(t, type) for t in types):
        return ()  # sys.modules["numpy"] is not numpy, for example a test's mock
    return types


# Every openpyxl module that holds NUMERIC_TYPES under that name.
_HOLDERS = (
    "openpyxl.compat.numbers",
    "openpyxl.compat",
    "openpyxl.compat.strings",
    "openpyxl.cell.rich_text",
    "openpyxl.cell.cell",
)
_found = ()


def _found_numpy_types():
    """Like _numpy_types(), but remembers the types once found, and then sets NUMERIC_TYPES in
    each imported module named in _HOLDERS to the tuple that openpyxl's own file builds."""
    global _found
    if not _found:
        types = _numpy_types()
        if types:
            for name in _HOLDERS:
                module = sys.modules.get(name)
                if module is not None:
                    module.NUMERIC_TYPES = (int, float, Decimal) + types
        _found = types
    return _found


class _NumpyNumberType(type):
    def __instancecheck__(cls, instance):
        return isinstance(instance, _found_numpy_types())

    def __subclasscheck__(cls, subclass):
        return issubclass(subclass, _found_numpy_types())


class _NumpyNumber(metaclass=_NumpyNumberType):
    """Stands in for numpy's number types in NUMERIC_TYPES while numpy is not imported."""


if NUMPY:
    NUMERIC_TYPES = NUMERIC_TYPES + (_numpy_types() or (_NumpyNumber,))
