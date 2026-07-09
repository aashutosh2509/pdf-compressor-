# Use an official Node runtime as a parent image
FROM node:18-bullseye-slim

# Install Ghostscript for PDF compression
RUN apt-get update && apt-get install -y ghostscript && rm -rf /var/lib/apt/lists/*

# Set the working directory to /app
WORKDIR /app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install any needed packages specified in package.json
RUN npm install --production

# Copy the rest of the application
COPY . .

# Expose the port the app runs on
EXPOSE 3000

# Run the app when the container launches
CMD ["npm", "start"]
