cmake_minimum_required(VERSION 3.0.2)
project(lightmem_ego_web)

find_package(catkin REQUIRED)

catkin_package()

install(PROGRAMS
  scripts/lightmem_ego_node.sh
  DESTINATION ${CATKIN_PACKAGE_BIN_DESTINATION}
)

install(DIRECTORY launch/
  DESTINATION ${CATKIN_PACKAGE_SHARE_DESTINATION}/launch
)
