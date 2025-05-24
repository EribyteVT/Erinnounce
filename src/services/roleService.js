import { databaseService } from "./databaseService.js";
import { channelService } from "./channelService.js";

export const roleService = {
  async loadRoles() {
    try {
      const roles = await databaseService.getRoles();
      channelService.setRoles(roles);
      return roles;
    } catch (error) {
      console.error("Failed to load roles:", error);
      throw error;
    }
  },

  getRoleForServer(serverId, channelType) {
    return channelService.getRoleFromServerAndType(serverId, channelType);
  }
};