exports.handler = async () => {
  return {
    statusCode: 501,
    body: JSON.stringify({
      error:
        "Ad-library pulls are not wired up yet. Waiting on confirmation from Markifact before this can be built for real.",
    }),
  };
};
