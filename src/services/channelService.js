let server_channels = [];
let all_input_channels = [];
let all_roles = [];

export const channelService = {
  setChannels(channels) {
    server_channels = channels;
    all_input_channels = this.getAllInputChannels();
  },

  setRoles(roles) {
    all_roles = roles;
  },

  getAllServersWithout(serverId, channelType) {
    return server_channels.filter((server) => {
      return server.server_id != serverId && server.channel_type == channelType;
    });
  },

  getAllInputChannels() {
    return server_channels.map((server) => server.channel_id_input);
  },

  getChannelInfo(channelId) {
    return server_channels.find((server) => server.channel_id_input == channelId);
  },

  getRoleFromServerAndType(serverId, type) {
    const all_roles_in_server = all_roles.filter((role) => {
      return role.server_id == serverId;
    });

    const correct_type_role = all_roles_in_server.find((role) => {
      return role.role_type == type;
    });

    return correct_type_role;
  },

  getServerChannels() {
    return server_channels;
  },

  getAllRoles() {
    return all_roles;
  }
};