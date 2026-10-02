# Replacement for OpenCAMLib's src/emscriptenlib/emscriptenlib.cmake (T5.0b spike).
#
# Same sources and the same upstream bindings (emscriptenlib.cpp); only the output changes:
# an ES module plus a separate .wasm (no SINGLE_FILE, no closure), for web, worker and node,
# single-threaded (the caller passes USE_OPENMP=OFF). build-ocl.sh copies this file over the
# upstream one in a scratch copy of the pinned checkout; nothing upstream is edited in place.

message(STATUS "Will build emscripten js library (manufakture spike flags)")

set(CMAKE_CXX_FLAGS_RELEASE "${CMAKE_CXX_FLAGS_RELEASE} -O3")

include_directories(${Boost_INCLUDE_DIRS})

include_directories(${PROJECT_SOURCE_DIR}/cutters)
include_directories(${PROJECT_SOURCE_DIR}/geo)
include_directories(${PROJECT_SOURCE_DIR}/algo)
include_directories(${PROJECT_SOURCE_DIR}/dropcutter)
include_directories(${PROJECT_SOURCE_DIR}/common)
include_directories(${PROJECT_SOURCE_DIR})
include_directories(${PROJECT_SOURCE_DIR}/emscriptenlib)

add_executable(ocl
	${OCL_GEO_SRC}
	${OCL_CUTTER_SRC}
	${OCL_DROPCUTTER_SRC}
	${OCL_ALGO_SRC}
	${OCL_COMMON_SRC}
	${PROJECT_SOURCE_DIR}/emscriptenlib/emscriptenlib.cpp
)

# Current embind (bind.h) needs C++17 (std::optional, std::conjunction); upstream sets C++14.
set_target_properties(ocl PROPERTIES SUFFIX ".mjs" CXX_STANDARD 17)

set_target_properties(ocl PROPERTIES LINK_FLAGS "\
	-O3 \
	-lembind \
	-sMODULARIZE=1 \
	-sEXPORT_ES6=1 \
	-sEXPORT_NAME=ocl \
	-sENVIRONMENT=web,worker,node \
	-sALLOW_MEMORY_GROWTH=1 \
	-sINITIAL_MEMORY=33554432 \
	-sSTACK_SIZE=1048576 \
	-sASSERTIONS=0 \
	-sEXPORTED_FUNCTIONS=['_malloc','_free','_sbrk'] \
	-sEXPORTED_RUNTIME_METHODS=['HEAPF64','HEAPU8']")
