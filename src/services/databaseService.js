import { pgClient } from "../config/database.js";

export const databaseService = {
  async getChannels() {
    try {
      await pgClient.connect();
      const result = await pgClient.query("SELECT * FROM alerts.channels");
      return result.rows;
    } catch (error) {
      console.error("Database connection error:", error);
      throw error;
    }
  },

  async getRoles() {
    try {
      await pgClient.connect();
      const result = await pgClient.query("SELECT * FROM alerts.roles");
      return result.rows;
    } catch (error) {
      console.error("Database connection error:", error);
      throw error;
    }
  }
};